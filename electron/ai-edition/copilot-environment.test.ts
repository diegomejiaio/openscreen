import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CopilotClient, RuntimeConnection } from "@github/copilot-sdk";
import { afterEach, expect, it, vi } from "vitest";
import { copilotClientOptions } from "./copilot";

vi.mock("electron", () => ({ app: { isPackaged: false } }));

afterEach(() => vi.unstubAllEnvs());

it.each([
	false,
	true,
])("filters the actual SDK child environment (explicit secret control: %s)", async (explicitSecret) => {
	const directory = await mkdtemp(join(tmpdir(), "openscreen-copilot-env-"));
	const runtime = join(directory, "probe.js");
	const output = join(directory, "observed.json");
	vi.stubEnv("OPENSCREEN_TEST_SECRET", "synthetic-marker");
	vi.stubEnv("GH_TOKEN", "synthetic-token");
	vi.stubEnv("HOME", "synthetic-home");
	await writeFile(
		runtime,
		`require("node:fs").writeFileSync(process.argv[2], JSON.stringify({
				secretPresent: process.env.OPENSCREEN_TEST_SECRET === "synthetic-marker",
				tokenPresent: typeof process.env.GH_TOKEN === "string",
				home: process.env.HOME
			}));`,
	);
	const options = copilotClientOptions(directory);
	const client = new CopilotClient({
		...options,
		connection: RuntimeConnection.forStdio({ path: runtime, args: [output] }),
		env: {
			...options.env,
			...(explicitSecret ? { OPENSCREEN_TEST_SECRET: "synthetic-marker" } : {}),
		},
	});
	try {
		// The local probe exits without implementing RPC; it never starts the real runtime.
		await expect(client.start()).rejects.toThrow();
		expect(JSON.parse(await readFile(output, "utf8"))).toEqual({
			secretPresent: explicitSecret,
			tokenPresent: false,
			home: "synthetic-home",
		});
	} finally {
		await client.forceStop();
		await rm(directory, { recursive: true, force: true });
	}
});
