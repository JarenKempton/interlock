import type { MapRef, TicketRef } from "../../../domain/model.ts";
import { mapRefSchema, ticketRefSchema } from "../../../domain/refs/identifiers.ts";
import { parseRef } from "../../../domain/refs/parse.ts";

export const GITHUB_NAMESPACE = "GH";
const KEY = /^GH-([1-9][0-9]*)$/;
const REPOSITORY = /^([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\/([A-Za-z0-9_.-]+)$/;

export interface IssueAddress {
  repository: string;
  number: number;
}

export function githubRepository(value: string): string {
  const match = REPOSITORY.exec(value.trim());
  if (!match || match[2] === "." || match[2] === "..")
    throw new Error("GitHub repository must be OWNER/NAME, such as octo-org/octo-repo");
  return `${match[1]}/${match[2]}`.toLowerCase();
}

export function githubInstance(repository: string): string {
  return githubRepository(repository).replace("/", ".");
}

export function githubRepositoryOf(instance: string): string {
  return githubRepository(instance.replace(".", "/"));
}

export function githubNamespace(key: string): string | undefined {
  return KEY.test(key) ? GITHUB_NAMESPACE : undefined;
}

export function issueRef(repository: string, number: number): TicketRef {
  return ticketRefSchema.parse(
    `github:${githubInstance(repository)}:${GITHUB_NAMESPACE}:ticket:GH-${number}`,
  );
}

export function issueMapRef(repository: string, number: number): MapRef {
  return mapRefSchema.parse(
    `github:${githubInstance(repository)}:${GITHUB_NAMESPACE}:map:GH-${number}`,
  );
}

export function issueAddress(ref: TicketRef | MapRef): IssueAddress {
  const parsed = parseRef(ref);
  const number = KEY.exec(parsed.nativeId ?? "")?.[1];
  if (
    parsed.adapter !== "github" ||
    parsed.namespace !== GITHUB_NAMESPACE ||
    !parsed.instance ||
    !number
  )
    throw new Error(`Not a GitHub issue reference: ${ref}`);
  return { repository: githubRepositoryOf(parsed.instance), number: Number(number) };
}

export function repositoryOfApiUrl(url: string): string {
  const match = /^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)$/.exec(url);
  if (!match?.[1]) throw new Error(`Unexpected GitHub repository URL: ${url}`);
  return githubRepository(match[1]);
}
