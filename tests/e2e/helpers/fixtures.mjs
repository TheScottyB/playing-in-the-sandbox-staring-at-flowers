import { generateKeyPairSync } from "node:crypto";
import { Jimp, JimpMime } from "jimp";

export async function createPngBuffer({
	width = 16,
	height = 16,
	rgba = 0x228833ff,
} = {}) {
	const img = new Jimp({ width, height, color: rgba });
	return await img.getBuffer(JimpMime.png);
}

export async function createPngBase64(opts = {}) {
	const buf = await createPngBuffer(opts);
	return buf.toString("base64");
}

export function createEphemeralEcPrivateKeyPem() {
	const { privateKey } = generateKeyPairSync("ec", {
		namedCurve: "prime256v1",
	});
	return privateKey.export({ type: "pkcs8", format: "pem" });
}
