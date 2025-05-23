import { readFileSync } from "fs";
import * as core from "@actions/core";
import OpenAI from "openai";
import { Octokit } from "@octokit/rest";
import minimatch from "minimatch";

const GITHUB_TOKEN: string = core.getInput("GITHUB_TOKEN");
const OPENAI_API_KEY: string = core.getInput("OPENAI_API_KEY");
const OPENAI_API_MODEL: string = core.getInput("OPENAI_API_MODEL");

const octokit = new Octokit({ auth: GITHUB_TOKEN });

const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
});

interface PRDetails {
  owner: string;
  repo: string;
  pull_number: number;
  title: string;
  description: string;
}

type Diff = {
  from: string;
  to: string;
  diff: string;
}

function splitDiffByFiles(diff: string): Diff[] {
  const fileDiffs = diff.split(/^diff --git a\/.+ b\/.+$/gm)
    .filter(Boolean);

  const headers = [...diff.matchAll(/^diff --git a\/(.+?) b\/(.+?)$/gm)];

  return fileDiffs.map((content, i) => ({
    from: headers[i][1],
    to: headers[i][2],
    diff: `diff --git a/${headers[i][1]} b/${headers[i][2]}\n${content}`
  }));
}

async function getPRDetails(): Promise<PRDetails> {
  const { repository, number } = JSON.parse(
    readFileSync(process.env.GITHUB_EVENT_PATH || "", "utf8")
  );
  const prResponse = await octokit.pulls.get({
    owner: repository.owner.login,
    repo: repository.name,
    pull_number: number,
  });
  return {
    owner: repository.owner.login,
    repo: repository.name,
    pull_number: number,
    title: prResponse.data.title ?? "",
    description: prResponse.data.body ?? "",
  };
}

async function getDiff(
  owner: string,
  repo: string,
  pull_number: number
): Promise<string | null> {
  const response = await octokit.pulls.get({
    owner,
    repo,
    pull_number,
    mediaType: { format: "diff" },
  });
  // @ts-expect-error - response.data is a string
  return response.data;
}

async function analyzeCode(
  parsedDiff: Diff[],
  prDetails: PRDetails
): Promise<Array<{ body: string; path: string; line: number }>> {
  const comments: Array<{ body: string; path: string; line: number }> = [];

  for (const diff of parsedDiff) {
    const prompt = createPrompt(diff, prDetails);
    const aiResponse = await getAIResponse(prompt);
    if (aiResponse) {
      const newComments = createComment(diff, aiResponse);
      if (newComments) {
        comments.push(...newComments);
      }
    }
  }
  return comments;
}

function createPrompt(diff: Diff, prDetails: PRDetails): string {
  return `Your task is to review pull requests. Instructions:
- Provide the response in following JSON format:  {"reviews": [{"lineNumber":  <line_number>, "side": "LEFT|RIGHT", "reviewComment": "<review comment>"}]}
- The "side" field should be "LEFT" for the original code and "RIGHT" for the new code.
- Be pragmatic and concise. Do not be pedantic.
- If something can be improved, please suggest the improvement in the same comment.
- Do not give positive comments or compliments.
- Remember lines starting with a "+" are new lines, lines starting with "-" are removed lines and lines starting with " " are unchanged lines.
- ONLY comment on changed lines
- Provide comments and suggestions ONLY if there is something to improve, otherwise "reviews" should be an empty array.
- Write the comment in GitHub Markdown format.
- Use the given description only for the overall context and only comment the code.
- IMPORTANT: NEVER suggest adding comments or documentation to the code.

Take the pull request title and description into account when writing the response.
  
Pull request title: ${prDetails.title}
Pull request description:

---
${prDetails.description}
---

Git diff to review:

\`\`\`diff
${diff.diff}
\`\`\`
`;
}

async function getAIResponse(prompt: string): Promise<Array<{
  lineNumber: string;
  side: 'LEFT' | 'RIGHT';
  reviewComment: string;
}> | null> {
  const queryConfig = {
    model: OPENAI_API_MODEL,
    temperature: 0.2,
    max_tokens: 700,
    top_p: 1,
    frequency_penalty: 0,
    presence_penalty: 0,
  };

  try {
    const response = await openai.chat.completions.create({
      ...queryConfig,
      // return JSON if the model supports it:
      ...(OPENAI_API_MODEL === "gpt-4-1106-preview"
        ? { response_format: { type: "json_object" } }
        : {}),
      messages: [
        {
          role: "system",
          content: prompt,
        },
      ],
    });

    const res = response.choices[0].message?.content?.trim() || "{}";
    return JSON.parse(res).reviews;
  } catch (error) {
    console.error("Error:", error);
    return null;
  }
}

function createComment(
  diff: Diff,
  aiResponses: Array<{
    lineNumber: string;
    side: "LEFT" | "RIGHT";
    reviewComment: string;
  }>
): Array<{ body: string; path: string; line: number }> {
  return aiResponses.flatMap((aiResponse) => {
    if (!diff.to) {
      return [];
    }
    return {
      body: aiResponse.reviewComment,
      path: diff.to,
      side: aiResponse.side,
      line: Number(aiResponse.lineNumber),
    };
  });
}

async function createReviewComment(
  owner: string,
  repo: string,
  pull_number: number,
  comments: Array<{ body: string; path: string; line: number }>
): Promise<void> {
  await octokit.pulls.createReview({
    owner,
    repo,
    pull_number,
    comments,
    event: "COMMENT",
  });
}

async function main() {
  const prDetails = await getPRDetails();
  let diff: string | null;
  const eventData = JSON.parse(
    readFileSync(process.env.GITHUB_EVENT_PATH ?? "", "utf8")
  );

  if (eventData.action === "opened") {
    diff = await getDiff(
      prDetails.owner,
      prDetails.repo,
      prDetails.pull_number
    );
  } else if (eventData.action === "synchronize") {
    const newBaseSha = eventData.before;
    const newHeadSha = eventData.after;

    const response = await octokit.repos.compareCommits({
      headers: {
        accept: "application/vnd.github.v3.diff",
      },
      owner: prDetails.owner,
      repo: prDetails.repo,
      base: newBaseSha,
      head: newHeadSha,
    });

    diff = String(response.data);
  } else {
    console.log("Unsupported event:", process.env.GITHUB_EVENT_NAME);
    return;
  }

  if (!diff) {
    console.log("No diff found");
    return;
  }

  const diffs = splitDiffByFiles(diff);

  const excludePatterns = core
    .getInput("exclude")
    .split("\n")
    .map((s) => s.trim());

  const filteredDiff = diffs.filter((diff) => {
    if (diff.to === "/dev/null") return false; // Ignore deleted files
    return !excludePatterns.some((pattern) =>
      minimatch(diff.to ?? "", pattern)
    );
  });

  if (filteredDiff.length === 0) {
    console.log("No files to analyze");
    return;
  }

  const comments = await analyzeCode(filteredDiff, prDetails);
  if (comments.length > 0) {
    await createReviewComment(
      prDetails.owner,
      prDetails.repo,
      prDetails.pull_number,
      comments
    );
  }
}

main().catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});
