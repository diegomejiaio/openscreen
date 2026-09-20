import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	start: vi.fn(),
	stop: vi.fn(),
	forceStop: vi.fn(),
	getAuthStatus: vi.fn(),
	listModels: vi.fn(),
	createSession: vi.fn(),
	sendAndWait: vi.fn(),
	on: vi.fn(),
	abort: vi.fn(),
	disconnect: vi.fn(),
	unsubscribe: vi.fn(),
}));
vi.mock("electron", () => ({ app: { getPath: () => "/tmp/openscreen-copilot-test" } }));
vi.mock("node:fs/promises", () => ({ mkdir: vi.fn() }));
vi.mock("@github/copilot-sdk", () => ({
	RuntimeConnection: { forStdio: () => ({ kind: "stdio" }) },
	CopilotClient: class {
		start = mocks.start;
		stop = mocks.stop;
		forceStop = mocks.forceStop;
		getAuthStatus = mocks.getAuthStatus;
		listModels = mocks.listModels;
		createSession = mocks.createSession;
	},
}));

import { copilotClientOptions, copilotPermissions, listCopilotModels, runCopilot } from "./copilot";

beforeEach(() => {
	vi.resetAllMocks();
	mocks.stop.mockResolvedValue([]);
	mocks.getAuthStatus.mockResolvedValue({ isAuthenticated: true });
	mocks.createSession.mockResolvedValue(mocks);
	mocks.sendAndWait.mockResolvedValue({ data: { content: "Done" } });
	mocks.on.mockReturnValue(mocks.unsubscribe);
});

afterEach(() => vi.unstubAllGlobals());

describe("Copilot SDK provider", () => {
	it("finds Homebrew GitHub CLI when launched from Finder", () => {
		vi.stubGlobal("process", {
			...process,
			platform: "darwin",
			env: { ...process.env, PATH: "/usr/bin:/bin" },
		});
		expect(copilotClientOptions("/tmp/openscreen").env.PATH).toBe(
			"/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin",
		);
	});
	it("isolates state and prevents inherited automation tokens overriding login", () => {
		const options = copilotClientOptions("/tmp/openscreen");
		expect(options.mode).toBe("empty");
		expect(options.baseDirectory).toBe("/tmp/openscreen");
		expect(options.workingDirectory).toBe("/tmp/openscreen");
		expect(options.connection.kind).toBe("stdio");
		expect(options.env.GH_TOKEN).toBeUndefined();
		expect(options.env.GITHUB_TOKEN).toBeUndefined();
		expect(options.env.COPILOT_GITHUB_TOKEN).toBeUndefined();
	});

	it.each([
		"darwin",
		"linux",
		"win32",
	])("allows only runtime and login environment variables on %s", (platform) => {
		const allowed = {
			HOME: "/home/test",
			USERPROFILE: "C:\\Users\\test",
			SystemRoot: "C:\\Windows",
			APPDATA: "C:\\Users\\test\\AppData\\Roaming",
			LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local",
			TMPDIR: "/tmp",
			GH_CONFIG_DIR: "/test/gh",
			XDG_CONFIG_HOME: "/test/config",
			DBUS_SESSION_BUS_ADDRESS: "unix:path=/test/bus",
			HTTPS_PROXY: "http://proxy.example:8080",
			https_proxy: "http://proxy.example:8080",
			NODE_EXTRA_CA_CERTS: "/test/ca.pem",
		};
		vi.stubGlobal("process", {
			...process,
			platform,
			env: {
				...allowed,
				PATH: "/test/bin",
				GH_TOKEN: "synthetic-token",
				GITHUB_TOKEN: "synthetic-token",
				COPILOT_GITHUB_TOKEN: "synthetic-token",
				COPILOT_SDK_AUTH_TOKEN: "synthetic-token",
				GH_ENTERPRISE_TOKEN: "synthetic-token",
				OPENAI_API_KEY: "synthetic-key",
				AWS_SECRET_ACCESS_KEY: "synthetic-key",
				FUTURE_PROVIDER_SECRET: "synthetic-key",
				NODE_OPTIONS: "--require=untrusted.js",
				COPILOT_CLI_PATH: "/untrusted/runtime",
				COPILOT_HOME: "/unrelated/profile",
			},
		});
		const env = copilotClientOptions("/tmp/openscreen").env;
		expect(env).toMatchObject(allowed);
		expect(Object.keys(env).sort()).toEqual([...Object.keys(allowed), "PATH"].sort());
		if (platform !== "darwin") expect(env.PATH).toBe("/test/bin");
	});

	it("lists enabled models and releases the runtime", async () => {
		mocks.listModels.mockResolvedValue([
			{ id: "enabled" },
			{ id: "blocked", policy: { state: "disabled" } },
		]);
		expect(await listCopilotModels()).toEqual(["enabled"]);
		expect(mocks.stop).toHaveBeenCalledOnce();
		expect(mocks.createSession).not.toHaveBeenCalled();
	});

	it("explains missing authentication without starting a session", async () => {
		mocks.getAuthStatus.mockResolvedValue({ isAuthenticated: false });
		await expect(listCopilotModels()).rejects.toThrow("gh auth login");
		expect(mocks.stop).toHaveBeenCalledOnce();
	});

	it("allows only named custom tools and refuses managed approval requests", () => {
		const handler = copilotPermissions(["getCurrentDocument"]);
		expect(
			handler(
				{
					kind: "custom-tool",
					toolName: "getCurrentDocument",
					toolDescription: "",
					args: {},
					toolCallId: "1",
				},
				{ sessionId: "test" },
			),
		).toEqual({ kind: "approve-once" });
		expect(
			handler(
				{
					kind: "custom-tool",
					toolName: "shell",
					toolDescription: "",
					args: {},
					toolCallId: "1",
				},
				{ sessionId: "test" },
			),
		).toEqual({ kind: "reject" });
		expect(
			handler(
				{
					kind: "custom-tool",
					toolName: "getCurrentDocument",
					toolDescription: "",
					args: {},
					toolCallId: "1",
					managedApprovalRequired: true,
				},
				{ sessionId: "test" },
			),
		).toEqual({ kind: "reject" });
	});

	it("text transforms cannot access any tools", async () => {
		expect(await runCopilot({ model: "test", system: "Translate", prompt: "Hello" })).toBe("Done");
		expect(mocks.createSession).toHaveBeenCalledWith(
			expect.objectContaining({
				tools: [],
				availableTools: [],
				excludedTools: ["builtin:*", "mcp:*"],
				enableConfigDiscovery: false,
				infiniteSessions: { enabled: false },
			}),
		);
		expect(mocks.sendAndWait).toHaveBeenCalledWith({ prompt: "Hello" }, 120_000);
		expect(mocks.abort).toHaveBeenCalledOnce();
		expect(mocks.disconnect).toHaveBeenCalledOnce();
		expect(mocks.stop).toHaveBeenCalledOnce();
	});

	it("aborts and cleans up a timed-out request", async () => {
		mocks.sendAndWait.mockRejectedValue(new Error("Timed out"));
		await expect(runCopilot({ model: "test", system: "", prompt: "Hello" })).rejects.toThrow(
			"Timed out",
		);
		expect(mocks.abort).toHaveBeenCalledOnce();
		expect(mocks.disconnect).toHaveBeenCalledOnce();
		expect(mocks.stop).toHaveBeenCalledOnce();
	});

	it("rejects empty results and already cancelled requests", async () => {
		mocks.sendAndWait.mockResolvedValue(undefined);
		await expect(runCopilot({ model: "test", system: "", prompt: "Hello" })).rejects.toThrow(
			"empty",
		);
		const controller = new AbortController();
		controller.abort();
		mocks.createSession.mockClear();
		await expect(
			runCopilot({ model: "test", system: "", prompt: "Hello", signal: controller.signal }),
		).rejects.toThrow();
		expect(mocks.createSession).not.toHaveBeenCalled();
	});
});
