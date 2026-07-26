import { Spectrum } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";

const app = await Spectrum({
  projectId: process.env.PHOTON_PROJECT_ID!,
  projectSecret: process.env.PHOTON_PROJECT_SECRET!,
  providers: [imessage.config()],
});

for await (const [space, message] of app.messages) {
  if (!imessage.is(space) || !imessage.is(message)) continue;
  if (space.type !== "dm" || message.direction !== "inbound") continue;

  const text = message.content.type === "text" ? message.content.text : "";
  if (!text.trim()) continue;

  await space.send("Received.");
}
