import { defineExtension, section } from "@earendil-works/pi-durable";

/** `tag` is a canonical BCP 47 tag; the prompt names the language in itself, so the model need not decode the tag. */
export const language = (tag: string) => {
	const name = new Intl.DisplayNames([tag], { type: "language" }).of(tag) ?? tag;
	return defineExtension({
		name: "soma.language",
		sections: [section("language", () => `回覆人時一律用 ${name}（${tag}），包括彙報、提醒與通知。`)],
	});
};
