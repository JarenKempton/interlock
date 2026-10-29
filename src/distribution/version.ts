declare const INTERLOCK_BUILD_VERSION: string | undefined;
export const RELEASE_BUILD = typeof INTERLOCK_BUILD_VERSION === "string";
export const VERSION =
  typeof INTERLOCK_BUILD_VERSION === "string" ? INTERLOCK_BUILD_VERSION : "0.1.0-dev";

// Release ownership is supplied by the build workflow, including forked releases.
declare const INTERLOCK_BUILD_RELEASES_URL: string | undefined;
export const RELEASES_URL =
  typeof INTERLOCK_BUILD_RELEASES_URL === "string" ? INTERLOCK_BUILD_RELEASES_URL : undefined;
