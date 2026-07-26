import { afterEach, describe, expect, it } from "vitest";
import {
  CANONICAL_REPOSITORY,
  DEFAULT_BRANCH,
  DEFAULT_CONFIG_DIRECTORY,
  DEFAULT_USER_ID,
  PACKAGE_NAME,
  PROJECT_NAME,
  PROJECT_VERSION,
  REPOSITORY_SLUG,
  UPGRADE_COMMAND,
} from "../server/project-metadata.js";
import { danielUserId } from "../server/composio.js";

describe("Daniel project metadata", () => {
  const originalComposioUserId = process.env.COMPOSIO_USER_ID;

  afterEach(() => {
    if (originalComposioUserId === undefined) {
      delete process.env.COMPOSIO_USER_ID;
    } else {
      process.env.COMPOSIO_USER_ID = originalComposioUserId;
    }
  });

  it("defines the canonical Daniel identity once", () => {
    expect(PROJECT_NAME).toBe("Daniel");
    expect(PACKAGE_NAME).toBe("daniel");
    expect(PROJECT_VERSION).toBe("0.1.0");
    expect(REPOSITORY_SLUG).toBe("tecxbro/daniel-ims-ag");
    expect(CANONICAL_REPOSITORY).toBe(
      "https://github.com/tecxbro/daniel-ims-ag.git",
    );
    expect(UPGRADE_COMMAND).toBe("/upgrade-daniel");
    expect(DEFAULT_CONFIG_DIRECTORY).toBe(".daniel");
    expect(DEFAULT_USER_ID).toBe("daniel-default");
    expect(DEFAULT_BRANCH).toBe("main");
  });

  it("uses the Daniel default integration identity", () => {
    delete process.env.COMPOSIO_USER_ID;
    expect(danielUserId()).toBe(DEFAULT_USER_ID);

    process.env.COMPOSIO_USER_ID = "custom-user";
    expect(danielUserId()).toBe("custom-user");
  });
});
