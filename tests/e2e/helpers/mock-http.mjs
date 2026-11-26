import { createServer } from "node:http";

export async function startMockServer(handler) {
	const requests = [];
	const server = createServer(async (req, res) => {
		const chunks = [];
		for await (const chunk of req) {
			chunks.push(chunk);
		}
		const rawBody = Buffer.concat(chunks).toString("utf8");
		let jsonBody = null;
		if (rawBody) {
			try {
				jsonBody = JSON.parse(rawBody);
			} catch {
				jsonBody = null;
			}
		}
		const record = {
			method: req.method,
			url: req.url,
			headers: req.headers,
			rawBody,
			jsonBody,
		};
		requests.push(record);
		await handler(record, res, requests.length);
	});

	await new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => resolve());
	});

	const addr = server.address();
	const url = `http://127.0.0.1:${addr.port}`;

	return {
		url,
		requests,
		close: () =>
			new Promise((resolve, reject) => {
				server.close((err) => (err ? reject(err) : resolve()));
			}),
	};
}
