import { mapMarketplacePromptToEnkiPrompt, type EnkiPrompt } from "@/lib/enkiPromptAdapter";

/** What a card already knows about a prompt, painted while
 *  /api/prompts/[id] loads. Only real data: what the card does not know
 *  is absent, never filled in. */
export interface ImageViewSeed {
  promptId: string;
  title?: string;
  artist?: { handle?: string; name?: string; id?: string };
  imageUrl?: string;
  showcase?: string[];
  isFree?: boolean;
}

/* The adapter fills every gap: "Untitled Prompt", "Enki Artist", and a grey
   SVG for each missing image (a card always carries four versions). Its
   answer for an empty record is exactly that filler, so comparing against it
   drops the filler without copying it here. */
const FILLER = mapMarketplacePromptToEnkiPrompt({});

export function seedFromEnkiPrompt(p: EnkiPrompt): ImageViewSeed {
  const real = (url: string) => url !== FILLER.art.url;
  const handle = p.artist.handle || undefined;
  const name = p.artist.name !== FILLER.artist.name ? p.artist.name : undefined;
  const id = p.artist.id || undefined;
  return {
    promptId: p.id,
    title: p.title !== FILLER.title ? p.title : undefined,
    artist: handle || name || id ? { handle, name, id } : undefined,
    imageUrl: real(p.art.url) ? p.art.url : undefined,
    showcase: [p.art, ...p.versions].map((v) => v.url).filter(real),
    isFree: p.visibility === "full",
  };
}
