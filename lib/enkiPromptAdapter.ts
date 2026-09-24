export type EnkiArtwork = {
  url: string;
  width: number;
  height: number;
  ratio: string;
};

/* One showcase image as the feed reads it: `after` is the output, `before`
   the input it was generated from (null for text to image), `addition` the
   text appended to the prompt when someone generates from this image. */
export type EnkiShowcaseImage = {
  after: string;
  before: string | null;
  addition: string | null;
};

export type EnkiArtist = {
  id?: string;
  name: string;
  handle: string;
  avatar: string;
  bio?: string;
};

export type EnkiPromptVariable = {
  name: string;
  label: string;
  type: "text" | "checkbox" | "image";
  value: string | boolean;
};

export type EnkiPrompt = {
  id: string;
  title: string;
  description: string;
  artist: EnkiArtist;
  tags: string[];
  price: number;
  downloads: number;
  rating: number;
  likes: number;
  isVideo: boolean;
  visibility: "full" | "vars-only";
  art: EnkiArtwork;
  before: string | null;
  showcase: EnkiShowcaseImage[];
  versions: EnkiArtwork[];
  variables: EnkiPromptVariable[];
  promptTemplate: string;
  model: string;
  publishedAt: string;
};

type UnknownRecord = Record<string, unknown>;

function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("") || "EA";
}

function dollars(value: unknown) {
  if (typeof value !== "number" || Number.isNaN(value)) return 0;
  return value > 20 ? value / 100 : value;
}

function asRecord(value: unknown): UnknownRecord {
  return value && typeof value === "object" ? value as UnknownRecord : {};
}

function readString(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

function readNumber(value: unknown) {
  return typeof value === "number" && !Number.isNaN(value) ? value : undefined;
}

function readArray(value: unknown) {
  return Array.isArray(value) ? value : [];
}

/* A URL the card can put in an <img>: https or site relative. Anything else
   (blob:, javascript:, plain text, http) is dropped with its entry. */
function imageUrl(value: unknown) {
  const url = readString(value)?.trim();
  return url && /^(https:\/\/|\/(?!\/))/.test(url) ? url : undefined;
}

/* Showcase entries arrive as bare URL strings, as { url } objects (the
   marketplace API today) or as { after, before, addition } objects once the
   backend carries input images. All three become one shape. */
export function normaliseShowcase(value: unknown): EnkiShowcaseImage[] {
  return readArray(value).flatMap((entry) => {
    const record: UnknownRecord = typeof entry === "string" ? { after: entry } : asRecord(entry);
    const after = imageUrl(record.after ?? record.url);
    if (!after) return [];
    return [{
      after,
      before: imageUrl(record.before) ?? null,
      addition: readString(record.addition)?.trim() || null,
    }];
  });
}

function imageFromUnknown(source: unknown): EnkiArtwork {
  if (typeof source === "string" && source.trim()) {
    return { url: source, width: 720, height: 960, ratio: "3:4" };
  }

  const record = asRecord(source);
  const image =
    readString(record.previewImageUrl) ||
    readString(record.thumbnail) ||
    readString(record.imageUrl) ||
    readString(record.url) ||
    readString(record.src);

  if (typeof image === "string" && image.trim()) {
    return { url: image, width: 720, height: 960, ratio: "3:4" };
  }

  /* No image available — return transparent placeholder */
  return { url: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='400' height='500'%3E%3Crect fill='%23e8e2d6' width='400' height='500'/%3E%3C/svg%3E", width: 400, height: 500, ratio: "4:5" };
}

function variablesFromUnknown(source: unknown): EnkiPromptVariable[] {
  const record = asRecord(source);
  const promptData = asRecord(record.promptData);
  const raw = readArray(promptData.variables).length ? readArray(promptData.variables) : readArray(record.variables);
  if (Array.isArray(raw) && raw.length > 0) {
    return raw.slice(0, 6).map((item, index: number) => {
      const variable = asRecord(item);
      const name = readString(variable.name) || readString(variable.label) || `variable_${index + 1}`;
      const label = readString(variable.label) || readString(variable.name) || `Variable ${index + 1}`;
      const type = variable.type === "checkbox" ? "checkbox" : "text";
      const defaultValue = variable.defaultValue ?? variable.default_value ?? variable.value;
      return {
        name: name.replace(/\s+/g, "_").toLowerCase(),
        label,
        type,
        value: type === "checkbox" ? Boolean(defaultValue) : String(defaultValue ?? ""),
      };
    });
  }

  return [];
}

function promptTemplateFrom(source: unknown, variables: EnkiPromptVariable[]) {
  const record = asRecord(source);
  const explicit =
    readString(record.promptTemplate) ||
    readString(record.publicPromptText) ||
    readString(record.prompt) ||
    readString(record.description);
  if (typeof explicit === "string" && explicit.includes("[")) return explicit;
  if (variables.length) {
    return `A refined editorial image of [${variables[0].name}], [${variables[1]?.name || variables[0].name}], lit by [${variables[2]?.name || variables[0].name}].`;
  }
  return "A refined editorial image with soft natural light, restrained composition, and precise art direction.";
}

export function mapMarketplacePromptToEnkiPrompt(prompt: unknown, index = 0): EnkiPrompt {
  const record = asRecord(prompt);
  const creator = asRecord(record.creator);
  const name = readString(creator.displayName) || readString(creator.username) || readString(record.artist) || "Enki Artist";
  const variables = variablesFromUnknown(prompt);
  const pricing = asRecord(record.pricing);
  const price = dollars(readNumber(record.priceUsdCents) ?? readNumber(record.price) ?? readNumber(pricing.pricePerGeneration));
  const id = String(readString(record.id) || readString(record._id) || `prompt_${index}`);
  const stats = asRecord(record.stats);
  const reviews = asRecord(stats.reviews);
  const showcase = normaliseShowcase(readArray(record.showcaseImages).length ? record.showcaseImages : record.previewImages);
  const art = imageFromUnknown(showcase[0]?.after ?? prompt);
  const listedAt = readString(record.listedAt);
  const createdAt = readString(record.createdAt);

  return {
    id,
    title: readString(record.title) || "Untitled Prompt",
    description: readString(record.description) || "",
    artist: {
      id: readString(creator.id) || readString(record.artistId) || readString(record.userId),
      name,
      /* The REAL handle or the uuid — never fabricated. This used to
         lowercase the display name and swap spaces for dots ("Enki Artist"
         → "enki.artist"), a handle that does not exist: every creator link
         from the feed 404'd (Kev, 2026-08-24). Handles cannot even contain
         dots (HANDLE_VALID). The uuid fallback works because the creator
         routes accept handle OR uuid. */
      handle:
        readString(creator.handle) ||
        readString(creator.username) ||
        readString(creator.id) ||
        readString(record.artistId) ||
        "",
      avatar: initials(name),
    },
    tags: readArray(record.tags).slice(0, 5).map(String),
    price,
    downloads: Number(readNumber(record.totalSales) ?? readNumber(record.downloads) ?? readNumber(stats.totalGenerations) ?? 0),
    rating: Number(readNumber(record.avgRating) ?? readNumber(record.rating) ?? readNumber(reviews.averageRating) ?? 0),
    likes: Number(readNumber(record.likes) ?? 0),
    isVideo: String(readString(record.category) || readString(record.promptType) || "").toLowerCase().includes("video") || Boolean(record.isVideo),
    visibility: record.visibility === "vars-only" || record.type === "premium" ? "vars-only" : "full",
    art,
    before: showcase[0]?.before ?? null,
    showcase,
    versions: [1, 2, 3, 4].map((offset) => imageFromUnknown(showcase[offset]?.after)),
    variables,
    promptTemplate: promptTemplateFrom(prompt, variables),
    model: readString(record.model) || readString(record.aiModel) || "Nano Banana Pro",
    publishedAt: listedAt || createdAt ? new Date(listedAt || createdAt || "").toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "",
  };
}

export function mapLegacyPromptToEnkiPrompt(prompt: unknown, index = 0) {
  return mapMarketplacePromptToEnkiPrompt(prompt, index);
}
