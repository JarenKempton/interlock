import type {
  GitHubFields,
  GitHubResponse,
  GitHubTransport,
} from "../../../src/adapters/trackers/github/transport.ts";

export interface FakeIssue {
  repository: string;
  number: number;
  title: string;
  state: "open" | "closed";
  assignees: string[];
  labels: string[];
  parent?: string;
  blockedBy: string[];
  comments: string[];
  type?: string;
  pullRequest?: boolean;
}

export class FakeGitHub {
  readonly issues = new Map<string, FakeIssue>();
  readonly requests: Array<{ method: string; path: string; fields?: GitHubFields }> = [];
  writes = 0;
  updated = 0;
  login = "octocat";
  failReadsAfterWrite = false;
  #unreadable = false;
  fail: (method: string, path: string) => number | undefined = () => undefined;

  add(repository: string, number: number, issue: Partial<FakeIssue> = {}): FakeIssue {
    const value: FakeIssue = {
      repository,
      number,
      title: `Issue ${number}`,
      state: "open",
      assignees: [],
      labels: [],
      blockedBy: [],
      comments: [],
      ...issue,
    };
    this.issues.set(`${repository}#${number}`, value);
    return value;
  }

  readonly transport: GitHubTransport = {
    request: async (method, path, fields) => {
      this.requests.push({ method, path, ...(fields ? { fields } : {}) });
      const failure = this.fail(method, path);
      if (failure) return { status: failure };
      if (method === "GET" && this.#unreadable) return { status: 502 };
      const response = this.#handle(method, path, fields ?? {});
      if (method !== "GET" && response.status < 300) {
        this.writes += 1;
        this.updated += 1;
        if (this.failReadsAfterWrite) this.#unreadable = true;
      }
      return response;
    },
  };

  readonly direct: GitHubTransport = {
    request: async (method, path, fields) => this.#handle(method, path, fields ?? {}),
  };

  #handle(method: string, path: string, fields: GitHubFields): GitHubResponse {
    if (method === "GET" && path === "user") return { status: 200, body: { login: this.login } };
    const [route = "", query = ""] = path.split("?");
    const page = Number(new URLSearchParams(query).get("page") ?? "1");
    const match = /^repos\/([^/]+\/[^/]+)\/issues\/(\d+)(\/.*)?$/.exec(route);
    const issue = match ? this.issues.get(`${match[1]}#${match[2]}`) : undefined;
    if (!issue) return { status: 404, body: { message: "Not Found" } };
    const rest = match?.[3] ?? "";
    const list = (items: FakeIssue[]) => ({
      status: 200,
      body: page === 1 ? items.map((item) => this.#json(item)) : [],
    });
    const lookup = (key: string) => {
      const found = this.issues.get(key);
      if (!found) throw new Error(`Unknown fake issue ${key}`);
      return found;
    };
    if (method === "GET" && rest === "") return { status: 200, body: this.#json(issue) };
    if (method === "GET" && rest === "/parent")
      return issue.parent
        ? { status: 200, body: this.#json(lookup(issue.parent)) }
        : { status: 404, body: { message: "No parent issue found" } };
    if (method === "GET" && rest === "/dependencies/blocked_by")
      return list(issue.blockedBy.map(lookup));
    if (method === "GET" && rest === "/dependencies/blocking")
      return list(
        [...this.issues.values()].filter((other) => other.blockedBy.includes(this.#key(issue))),
      );
    if (method === "GET" && rest === "/sub_issues")
      return list([...this.issues.values()].filter((other) => other.parent === this.#key(issue)));
    if (method === "GET" && rest === "/comments")
      return {
        status: 200,
        body: page === 1 ? issue.comments.map((body) => ({ body })) : [],
      };
    if (method === "POST" && rest === "/labels") {
      for (const label of arrayField(fields, "labels"))
        if (!issue.labels.includes(label)) issue.labels.push(label);
      return { status: 200, body: issue.labels.map((name) => ({ name })) };
    }
    if (method === "DELETE" && rest.startsWith("/labels/")) {
      const label = decodeURIComponent(rest.slice("/labels/".length));
      if (!issue.labels.includes(label)) return { status: 404 };
      issue.labels = issue.labels.filter((item) => item !== label);
      return { status: 200, body: [] };
    }
    if (method === "POST" && rest === "/assignees") {
      for (const login of arrayField(fields, "assignees"))
        if (!issue.assignees.includes(login)) issue.assignees.push(login);
      return { status: 201, body: this.#json(issue) };
    }
    if (method === "DELETE" && rest === "/assignees") {
      const removed = arrayField(fields, "assignees");
      issue.assignees = issue.assignees.filter((login) => !removed.includes(login));
      return { status: 200, body: this.#json(issue) };
    }
    if (method === "PATCH" && rest === "") {
      if (fields.state === "closed" || fields.state === "open") issue.state = fields.state;
      return { status: 200, body: this.#json(issue) };
    }
    if (method === "POST" && rest === "/comments") {
      issue.comments.push(String(fields.body));
      return { status: 201, body: { body: fields.body } };
    }
    return { status: 404 };
  }

  #key(issue: FakeIssue): string {
    return `${issue.repository}#${issue.number}`;
  }

  #json(issue: FakeIssue) {
    return {
      number: issue.number,
      title: issue.title,
      body: `Body of ${issue.number}`,
      html_url: `https://github.com/${issue.repository}/issues/${issue.number}`,
      state: issue.state,
      updated_at: `2026-11-13T00:00:${String(this.updated).padStart(2, "0")}Z`,
      repository_url: `https://api.github.com/repos/${issue.repository}`,
      assignees: issue.assignees.map((login) => ({ login })),
      labels: issue.labels.map((name) => ({ name })),
      type: issue.type ? { name: issue.type } : null,
      ...(issue.pullRequest ? { pull_request: { url: "x" } } : {}),
    };
  }
}

function arrayField(fields: GitHubFields, name: string): readonly string[] {
  const value = fields[name];
  return typeof value === "string" ? [value] : (value ?? []);
}
