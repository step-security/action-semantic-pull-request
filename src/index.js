import core from '@actions/core';
import github from '@actions/github';
import axios from 'axios';
import fs from 'fs';
import parseConfig from './parseConfig.js';
import validatePrTitle from './validatePrTitle.js';

async function run() {
  try {
    await validateSubscription();
    const {
      types,
      scopes,
      requireScope,
      disallowScopes,
      wip,
      subjectPattern,
      subjectPatternError,
      headerPattern,
      headerPatternCorrespondence,
      validateSingleCommit,
      validateSingleCommitMatchesPrTitle,
      githubBaseUrl,
      ignoreLabels
    } = parseConfig();

    const client = github.getOctokit(process.env.GITHUB_TOKEN, {
      baseUrl: githubBaseUrl
    });

    const contextPullRequest = github.context.payload.pull_request;
    if (!contextPullRequest) {
      throw new Error(
        "This action can only be invoked in `pull_request_target` or `pull_request` events. Otherwise the pull request can't be inferred."
      );
    }

    const owner = contextPullRequest.base.user.login;
    const repo = contextPullRequest.base.repo.name;

    // The pull request info on the context isn't up to date. When
    // the user updates the title and re-runs the workflow, it would
    // be outdated. Therefore fetch the pull request via the REST API
    // to ensure we use the current title.
    const {data: pullRequest} = await client.rest.pulls.get({
      owner,
      repo,
      pull_number: contextPullRequest.number
    });

    // Ignore errors if specified labels are added.
    if (ignoreLabels) {
      const labelNames = pullRequest.labels.map((label) => label.name);
      for (const labelName of labelNames) {
        if (ignoreLabels.includes(labelName)) {
          core.info(
            `Validation was skipped because the PR label "${labelName}" was found.`
          );
          return;
        }
      }
    }

    // Pull requests that start with "[WIP] " are excluded from the check.
    const isWip = wip && /^\[WIP\]\s/.test(pullRequest.title);

    let validationError;
    if (!isWip) {
      try {
        await validatePrTitle(pullRequest.title, {
          types,
          scopes,
          requireScope,
          disallowScopes,
          subjectPattern,
          subjectPatternError,
          headerPattern,
          headerPatternCorrespondence
        });

        if (validateSingleCommit) {
          const commits = [];
          let nonMergeCommits = [];

          for await (const response of client.paginate.iterator(
            client.rest.pulls.listCommits,
            {
              owner,
              repo,
              pull_number: contextPullRequest.number
            }
          )) {
            commits.push(...response.data);

            // GitHub does not count merge commits when deciding whether to use
            // the PR title or a commit message for the squash commit message.
            nonMergeCommits = commits.filter(
              (commit) => commit.parents.length < 2
            );

            // We only need two non-merge commits to know that the PR
            // title won't be used.
            if (nonMergeCommits.length >= 2) break;
          }

          // If there is only one (non merge) commit present, GitHub will use
          // that commit rather than the PR title for the title of a squash
          // commit. To make sure a semantic title is used for the squash
          // commit, we need to validate the commit title.
          if (nonMergeCommits.length === 1) {
            try {
              await validatePrTitle(nonMergeCommits[0].commit.message, {
                types,
                scopes,
                requireScope,
                disallowScopes,
                subjectPattern,
                subjectPatternError,
                headerPattern,
                headerPatternCorrespondence
              });
              // eslint-disable-next-line unicorn/prefer-optional-catch-binding, no-unused-vars -- Legacy syntax for compatibility
            } catch (error) {
              throw new Error(
                `Pull request has only one commit and it's not semantic; this may lead to a non-semantic commit in the base branch (see https://github.com/community/community/discussions/16271 ). Amend the commit message to match the pull request title, or add another commit.`
              );
            }

            if (validateSingleCommitMatchesPrTitle) {
              const commitTitle =
                nonMergeCommits[0].commit.message.split('\n')[0];
              if (commitTitle !== pullRequest.title) {
                throw new Error(
                  `The pull request has only one (non-merge) commit and in this case Github will use it as the default commit message when merging. The pull request title doesn't match the commit though ("${pullRequest.title}" vs. "${commitTitle}"). Please update the pull request title accordingly to avoid surprises.`
                );
              }
            }
          }
        }
      } catch (error) {
        validationError = error;
      }
    }

    if (wip) {
      const newStatus =
        isWip || validationError != null ? 'pending' : 'success';

      // When setting the status to "pending", the checks don't
      // complete. This can be used for WIP PRs in repositories
      // which don't support draft pull requests.
      // https://developer.github.com/v3/repos/statuses/#create-a-status
      await client.request('POST /repos/:owner/:repo/statuses/:sha', {
        owner,
        repo,
        sha: pullRequest.head.sha,
        state: newStatus,
        target_url:
          'https://github.com/step-security/action-semantic-pull-request',
        description: isWip
          ? 'This PR is marked with "[WIP]".'
          : validationError
            ? 'PR title validation failed'
            : 'Ready for review & merge.',
        context: 'action-semantic-pull-request'
      });
    }

    if (!isWip && validationError) {
      throw validationError;
    }
  } catch (error) {
    core.setFailed(error.message);
  }
}

async function validateSubscription() {
  let repoPrivate;
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (eventPath && fs.existsSync(eventPath)) {
    const payload = JSON.parse(fs.readFileSync(eventPath, "utf8"));
    repoPrivate = payload?.repository?.private;
  }

  const upstream = "amannn/action-semantic-pull-request";
  const action = process.env.GITHUB_ACTION_REPOSITORY;
  const docsUrl =
    "https://docs.stepsecurity.io/actions/stepsecurity-maintained-actions";

  core.info("");
  core.info("\u001b[1;36mStepSecurity Maintained Action\u001b[0m");
  core.info(`Secure drop-in replacement for ${upstream}`);
  if (repoPrivate === false)
    core.info("\u001b[32m\u2713 Free for public repositories\u001b[0m");
  core.info(`\u001b[36mLearn more:\u001b[0m ${docsUrl}`);
  core.info("");

  if (repoPrivate === false) return;
  const serverUrl = process.env.GITHUB_SERVER_URL || "https://github.com";
  const body = { action: action || "" };

  if (serverUrl !== "https://github.com") body.ghes_server = serverUrl;
  try {
    await axios.post(
      `https://agent.api.stepsecurity.io/v1/github/${process.env.GITHUB_REPOSITORY}/actions/maintained-actions-subscription`,
      body,
      { timeout: 3000 },
    );
  } catch (error) {
    if (axios.isAxiosError(error) && error.response?.status === 403) {
      core.error(
        `\u001b[1;31mThis action requires a StepSecurity subscription for private repositories.\u001b[0m`,
      );
      core.error(
        `\u001b[31mLearn how to enable a subscription: ${docsUrl}\u001b[0m`,
      );
      process.exit(1);
    }
    core.info("Timeout or API not reachable. Continuing to next step.");
  }
}

await run();
