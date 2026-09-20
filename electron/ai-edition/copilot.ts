import { mkdir } from "node:fs/promises";
import { delimiter, join } from "node:path";
import {
	CopilotClient,
	type PermissionHandler,
	RuntimeConnection,
	type Tool,
} from "@github/copilot-sdk";
import { app } from "electron";

const TIMEOUT_MS = 120_000;
const RUNTIME_ENV_KEYS = [
	"PATH",
	"HOME",
	"USERPROFILE",
	"HOMEDRIVE",
	"HOMEPATH",
	"APPDATA",
	"LOCALAPPDATA",
	"SystemRoot",
	"WINDIR",
	"COMSPEC",
	"PATHEXT",
	"TMPDIR",
	"TMP",
	"TEMP",
	"XDG_CONFIG_HOME",
	"XDG_CACHE_HOME",
	"XDG_RUNTIME_DIR",
	"DBUS_SESSION_BUS_ADDRESS",
	"GH_CONFIG_DIR",
	"GH_HOST",
	"LANG",
	"LC_ALL",
	"LC_CTYPE",
	"TZ",
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"ALL_PROXY",
	"NO_PROXY",
	"http_proxy",
	"https_proxy",
	"all_proxy",
	"no_proxy",
	"NODE_EXTRA_CA_CERTS",
	"SSL_CERT_FILE",
	"SSL_CERT_DIR",
] as const;

export function copilotClientOptions(directory: string) {
	const env: Record<string, string> = {};
	for (const key of RUNTIME_ENV_KEYS) {
		const value = process.env[key];
		if (value !== undefined) env[key] = value;
	}
	// Finder omits Homebrew's directories, where GitHub CLI is commonly installed.
	if (process.platform === "darwin") {
		env.PATH = [env.PATH, "/opt/homebrew/bin", "/usr/local/bin"].filter(Boolean).join(delimiter);
	}
	const platform = `${process.platform}-${process.arch}`;
	const runtimePath = app.isPackaged
		? join(
				process.resourcesPath,
				"app.asar.unpacked",
				"node_modules",
				"@github",
				`copilot-sdk-${platform}`,
				"prebuilds",
				platform,
				process.platform === "win32" ? "copilot-runtime.exe" : "copilot-runtime",
			)
		: undefined;
	return {
		mode: "empty" as const,
		connection: RuntimeConnection.forStdio({ path: runtimePath }),
		baseDirectory: directory,
		workingDirectory: directory,
		useLoggedInUser: true,
		logLevel: "error" as const,
		env,
	};
}

async function withClient<T>(run: (client: CopilotClient) => Promise<T>): Promise<T> {
	const directory = join(app.getPath("userData"), "copilot");
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const client = new CopilotClient(copilotClientOptions(directory));
	try {
		await client.start();
		const auth = await client.getAuthStatus();
		if (!auth.isAuthenticated) {
			throw new Error("Sign in with GitHub CLI (gh auth login), then retry GitHub Copilot.");
		}
		return await run(client);
	} finally {
		const errors = await client.stop();
		if (errors.length) {
			console.error(
				"[copilot] Runtime cleanup failed",
				errors.map((e) => e.message),
			);
			await client.forceStop();
		}
	}
}

export async function listCopilotModels(): Promise<string[]> {
	return withClient(async (client) => {
		const models = await client.listModels();
		return models.filter((model) => model.policy?.state !== "disabled").map((model) => model.id);
	});
}

export function copilotPermissions(names: readonly string[]): PermissionHandler {
	const allowed = new Set(names);
	return (request) =>
		!request.managedApprovalRequired &&
		request.kind === "custom-tool" &&
		allowed.has(request.toolName)
			? { kind: "approve-once" }
			: { kind: "reject" };
}

export async function runCopilot(options: {
	model: string;
	system: string;
	prompt: string;
	tools?: Tool[];
	onText?: (delta: string) => void;
	signal?: AbortSignal;
}): Promise<string> {
	options.signal?.throwIfAborted();
	return withClient(async (client) => {
		const tools = options.tools ?? [];
		const session = await client.createSession({
			model: options.model,
			clientName: "openscreen",
			systemMessage: { mode: "append", content: options.system },
			tools,
			availableTools: tools.map((tool) => `custom:${tool.name}`),
			excludedTools: ["builtin:*", "mcp:*"],
			toolSearch: { enabled: false },
			onPermissionRequest: copilotPermissions(tools.map((tool) => tool.name)),
			enableConfigDiscovery: false,
			infiniteSessions: { enabled: false },
			streaming: true,
		});
		let closed = false;
		const abort = () => {
			void session.abort().catch((error: unknown) => {
				if (!closed) console.error("[copilot] Could not abort request", error);
			});
		};
		options.signal?.addEventListener("abort", abort, { once: true });
		const unsubscribe = session.on("assistant.message_delta", (event) => {
			options.onText?.(event.data.deltaContent);
		});
		try {
			options.signal?.throwIfAborted();
			const result = await session.sendAndWait({ prompt: options.prompt }, TIMEOUT_MS);
			options.signal?.throwIfAborted();
			const text = result?.data.content.trim();
			if (!text) throw new Error("GitHub Copilot returned an empty response.");
			return text;
		} finally {
			closed = true;
			unsubscribe();
			options.signal?.removeEventListener("abort", abort);
			try {
				await session.abort();
			} finally {
				await session.disconnect();
			}
		}
	});
}
