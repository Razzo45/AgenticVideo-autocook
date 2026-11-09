import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isAuthError, requireUser, resolveAuthUser } from "../../src/auth/resolve";
import { mintLaunchToken, signHs256, verifyHs256 } from "../../src/auth/jwt";

const saved = {
  AUTH_MODE: process.env.AUTH_MODE,
  AUTOCOOK_SERVICE_TOKEN: process.env.AUTOCOOK_SERVICE_TOKEN,
  AUTOCOOK_JWT_SECRET: process.env.AUTOCOOK_JWT_SECRET,
  DEV_USER_ID: process.env.DEV_USER_ID,
};

function restore(): void {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

describe("auth", () => {
  it("signs and rejects a launch token", () => {
    const token = signHs256(
      { sub: "user-1", aud: "autocook", iat: 1, exp: Math.floor(Date.now() / 1000) + 60, tenant_id: "t1" },
      "test-secret",
    );
    assert.equal(verifyHs256(token, "test-secret").sub, "user-1");
    assert.throws(() => verifyHs256(token, "other-secret"), /invalid signature/);
    assert.throws(
      () => verifyHs256(signHs256({ sub: "user-1", aud: "other", iat: 1, exp: 9_999_999_999 }, "test-secret"), "test-secret"),
      /audience/,
    );
  });

  it("mints a token the resolver accepts as the caller", async () => {
    process.env.AUTH_MODE = "strict";
    process.env.AUTOCOOK_JWT_SECRET = "unit-test-secret";
    delete process.env.AUTOCOOK_SERVICE_TOKEN;
    try {
      const token = mintLaunchToken({ userId: "platform-user", tenantId: "acme", ttlSec: 60 });
      const user = await resolveAuthUser(new Request("http://localhost/api/cook", { headers: { authorization: `Bearer ${token}` } }));
      assert.equal(user?.userId, "platform-user");
      assert.equal(user?.tenantId, "acme");
      assert.equal(user?.kind, "launch");
    } finally {
      restore();
    }
  });

  it("accepts a service token only with a user id", async () => {
    process.env.AUTH_MODE = "strict";
    process.env.AUTOCOOK_SERVICE_TOKEN = "svc-unit-token";
    try {
      const missing = await resolveAuthUser(
        new Request("http://localhost/api/cook", { headers: { authorization: "Bearer svc-unit-token" } }),
      );
      assert.equal(missing, null);
      const user = await resolveAuthUser(
        new Request("http://localhost/api/cook", {
          headers: { authorization: "Bearer svc-unit-token", "x-user-id": "mother-user", "x-tenant-id": "t" },
        }),
      );
      assert.equal(user?.kind, "service");
      assert.equal(user?.userId, "mother-user");
    } finally {
      restore();
    }
  });

  it("uses the dev user locally and refuses a strict request with no credentials", async () => {
    process.env.AUTH_MODE = "dev";
    process.env.DEV_USER_ID = "local-dev";
    delete process.env.AUTOCOOK_SERVICE_TOKEN;
    try {
      const dev = await resolveAuthUser(new Request("http://localhost/api/cook"));
      assert.equal(dev?.kind, "dev");
      assert.equal(dev?.userId, "local-dev");
    } finally {
      restore();
    }

    process.env.AUTH_MODE = "strict";
    delete process.env.AUTOCOOK_SERVICE_TOKEN;
    try {
      await assert.rejects(() => requireUser(new Request("http://localhost/api/cook")), (err: unknown) => {
        assert.equal(isAuthError(err), true);
        return true;
      });
    } finally {
      restore();
    }
  });
});
