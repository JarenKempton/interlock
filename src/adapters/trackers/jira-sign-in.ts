import { z } from "zod";
import type { TrackerSignIn } from "../../domain/tracker.ts";
import { fetchTransport, type HttpTransport } from "./http.ts";
import { jiraBasicAuthTransport, jiraOrigin } from "./jira.ts";

const REQUIRED_PERMISSIONS = {
  BROWSE_PROJECTS: "Browse projects",
  TRANSITION_ISSUES: "Transition issues",
  ASSIGN_ISSUES: "Assign issues",
  EDIT_ISSUES: "Edit issues (issue properties)",
} as const;

const myselfSchema = z.object({ displayName: z.string().min(1) });
const permissionsSchema = z.object({
  permissions: z.record(z.string(), z.object({ havePermission: z.boolean() })),
});

const JIRA_TOKEN_LENGTH = 192;

export function jiraApiToken(pasted: string): string {
  const token = pasted.trim();
  const valid = token.slice(0, JIRA_TOKEN_LENGTH);
  return token.length > JIRA_TOKEN_LENGTH && /=[0-9A-Fa-f]{8}$/.test(valid) ? valid : token;
}

const jiraCredentialsSchema = z.object({ email: z.string().min(1), token: z.string().min(1) });

export function jiraSignIn(
  http: HttpTransport = fetchTransport,
): TrackerSignIn<z.infer<typeof jiraCredentialsSchema>> {
  const transport = (site: string, credentials: { email: string; token: string }) =>
    jiraBasicAuthTransport({ site, ...credentials }, http);
  return {
    site: { label: "Jira site", environment: "JIRA_SITE", parse: jiraOrigin },
    credentials: jiraCredentialsSchema,
    tokenPage: "https://id.atlassian.com/manage-profile/security/api-tokens",
    fields: [
      { name: "email", label: "Atlassian email", environment: "JIRA_USER_EMAIL", hidden: false },
      {
        name: "token",
        label: "Atlassian API token",
        environment: "JIRA_API_TOKEN",
        hidden: true,
        normalize: jiraApiToken,
      },
    ],
    async verify(site, credentials) {
      const response = await transport(site, credentials).request("GET", "/rest/api/3/myself");
      if (response.status === 401) throw new Error("Jira rejected the email or API token (401)");
      const parsed = myselfSchema.safeParse(response.body);
      if (response.status !== 200 || !parsed.success)
        throw new Error(`Jira sign-in check failed (${response.status})`);
      return { name: parsed.data.displayName };
    },
    async missingPermissions(site, credentials, project) {
      const query = new URLSearchParams({
        permissions: Object.keys(REQUIRED_PERMISSIONS).join(","),
      });
      if (project) query.set("projectKey", project);
      const response = await transport(site, credentials).request(
        "GET",
        `/rest/api/3/mypermissions?${query}`,
      );
      if (project && response.status === 404) return [`Jira project ${project} is not visible`];
      const parsed = permissionsSchema.safeParse(response.body);
      if (response.status !== 200 || !parsed.success)
        throw new Error(`Jira permission check failed (${response.status})`);
      return Object.entries(REQUIRED_PERMISSIONS)
        .filter(([key]) => parsed.data.permissions[key]?.havePermission !== true)
        .map(
          ([key, label]) => `Jira permission ${label} (${key})${project ? ` in ${project}` : ""}`,
        );
    },
  };
}
