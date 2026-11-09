import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";
import { NextRequest } from "next/server";
import { config, middleware } from "../../middleware";
import { takeMultipartInputs } from "../../src/pipeline/multipartInputs";

describe("page middleware", () => {
  it("does not match API routes, so a cook body is not cloned", () => {
    const matcher = config.matcher[0] ?? "";
    assert.match(matcher, /\(\?!api\//);
    assert.equal("/api/cook".match(/^\/((?!api\/|_next\/static|_next\/image|favicon.ico).*)$/), null);
    assert.equal("/".match(/^\/((?!api\/|_next\/static|_next\/image|favicon.ico).*)$/)?.[1], "");
  });

  it("lets a dev page through and stops a strict page without a session", () => {
    const previous = process.env.AUTH_MODE;
    process.env.AUTH_MODE = "dev";
    try {
      const open = middleware(new NextRequest("http://localhost/"));
      assert.notEqual(open.status, 401);
    } finally {
      if (previous === undefined) delete process.env.AUTH_MODE;
      else process.env.AUTH_MODE = previous;
    }

    process.env.AUTH_MODE = "strict";
    try {
      const page = middleware(new NextRequest("http://localhost/"));
      assert.equal(page.status, 401);
      const api = middleware(new NextRequest("http://localhost/api/cook"));
      assert.notEqual(api.status, 401);
    } finally {
      if (previous === undefined) delete process.env.AUTH_MODE;
      else process.env.AUTH_MODE = previous;
    }
  });
});

describe("multipart inputs", () => {
  it("writes each file to disk and cleanup removes them", async () => {
    const form = new FormData();
    form.append("inputs", new File([Buffer.from("png-bytes")], "logo.png", { type: "image/png" }));
    form.append("prompt", "ignored by the reader");
    const taken = await takeMultipartInputs(form);
    try {
      assert.equal(taken.files.length, 1);
      const file = taken.files[0];
      assert.ok(file && "sourcePath" in file);
      assert.equal(file.originalName, "logo.png");
      assert.equal(fs.readFileSync(file.sourcePath, "utf8"), "png-bytes");
    } finally {
      const file = taken.files[0];
      const dest = file && "sourcePath" in file ? file.sourcePath : undefined;
      taken.cleanup();
      if (dest) assert.equal(fs.existsSync(dest), false);
    }
  });

  it("returns no files when the form has none", async () => {
    const taken = await takeMultipartInputs(new FormData());
    assert.deepEqual(taken.files, []);
    taken.cleanup();
  });
});
