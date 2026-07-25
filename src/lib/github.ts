// GitHub REST v3 over plain fetch (no SDK dep — Workers-safe). Auth is the
// owner's fine-grained PAT (Contents + Pull requests read/write on one repo).
//
// Safety invariant: we NEVER write to the repo's default branch. Export creates
// commits only on `checkmyapp/*` branches and proposes them as a PR — the
// branch guard in openSpecsPr enforces this even if a caller misuses the API.

const API = "https://api.github.com";

export class GitHubError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "GitHubError";
  }
}

async function gh<T>(
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      // GitHub rejects requests without a User-Agent.
      "User-Agent": "checkmyapp",
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    // Surface GitHub's own message ("Bad credentials", "Reference already
    // exists", …) — the caller decides what is recoverable.
    const detail = await res
      .json()
      .then((j) => (j as { message?: string }).message)
      .catch(() => undefined);
    throw new GitHubError(res.status, detail ?? `GitHub API ${res.status}`);
  }
  return (await res.json()) as T;
}

// Canonical filename for a generated spec, mirroring /api/tests/{id} downloads.
export function specFileSlug(title: string): string {
  return (
    title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "journey"
  );
}

// Connect-time check: token must see the repo and be allowed to push to it
// (push permission is what lets us create branches; merging the PR stays with
// the owner). Returns the default branch so export never has to guess it.
export async function validateRepoAccess(
  token: string,
  repoFullName: string,
): Promise<{ defaultBranch: string }> {
  const repo = await gh<{
    default_branch: string;
    permissions?: { push?: boolean };
  }>(token, "GET", `/repos/${repoFullName}`);
  if (!repo.permissions?.push) {
    throw new GitHubError(
      403,
      "Token can read this repo but not write to it — grant Contents: read & write.",
    );
  }
  return { defaultBranch: repo.default_branch };
}

export interface SpecFile {
  path: string; // e.g. "e2e/checkmyapp/submit-a-check.spec.ts"
  content: string;
}

// Create/refresh a `checkmyapp/*` branch with the spec files and open (or
// reuse) a PR against the default branch. Idempotent per branch: re-export of
// the same run force-updates the branch and returns the existing open PR.
export async function openSpecsPr(opts: {
  token: string;
  repoFullName: string;
  baseBranch: string;
  branch: string;
  files: SpecFile[];
  title: string;
  body: string;
}): Promise<{ prUrl: string; created: boolean }> {
  const { token, repoFullName: repo, baseBranch, branch, files } = opts;
  if (!branch.startsWith("checkmyapp/") || branch === baseBranch) {
    throw new GitHubError(400, `Refusing to write to branch "${branch}" — PR-only export.`);
  }

  const baseRef = await gh<{ object: { sha: string } }>(
    token,
    "GET",
    `/repos/${repo}/git/ref/heads/${encodeURIComponent(baseBranch)}`,
  );
  const baseSha = baseRef.object.sha;
  const baseCommit = await gh<{ tree: { sha: string } }>(
    token,
    "GET",
    `/repos/${repo}/git/commits/${baseSha}`,
  );

  // One commit on top of the base head: tree API takes UTF-8 content inline.
  const tree = await gh<{ sha: string }>(token, "POST", `/repos/${repo}/git/trees`, {
    base_tree: baseCommit.tree.sha,
    tree: files.map((f) => ({ path: f.path, mode: "100644", type: "blob", content: f.content })),
  });
  const commit = await gh<{ sha: string }>(token, "POST", `/repos/${repo}/git/commits`, {
    message: opts.title,
    tree: tree.sha,
    parents: [baseSha],
  });

  try {
    await gh(token, "POST", `/repos/${repo}/git/refs`, {
      ref: `refs/heads/${branch}`,
      sha: commit.sha,
    });
  } catch (e) {
    // 422 "Reference already exists" → re-export: move our branch to the new commit.
    if (!(e instanceof GitHubError && e.status === 422)) throw e;
    await gh(token, "PATCH", `/repos/${repo}/git/refs/heads/${encodeURIComponent(branch)}`, {
      sha: commit.sha,
      force: true,
    });
  }

  try {
    const pr = await gh<{ html_url: string }>(token, "POST", `/repos/${repo}/pulls`, {
      title: opts.title,
      head: branch,
      base: baseBranch,
      body: opts.body,
    });
    return { prUrl: pr.html_url, created: true };
  } catch (e) {
    // 422 "A pull request already exists" → return the open one for this branch.
    if (!(e instanceof GitHubError && e.status === 422)) throw e;
    const owner = repo.split("/")[0];
    const existing = await gh<{ html_url: string }[]>(
      token,
      "GET",
      `/repos/${repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}`,
    );
    if (!existing[0]) throw e;
    return { prUrl: existing[0].html_url, created: false };
  }
}
