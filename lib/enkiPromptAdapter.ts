export type EnkiArtwork = {
  url: string;
  width: number;
  height: number;
  ratio: string;
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

function firstImageUrl(value: unknown) {
  const first = readArray(value)[0];
  if (typeof first === "string" && first.trim()) return first;
  const record = asRecord(first);
  return readString(record.url) || readString(record.thumbnail);
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
    readString(record.src) ||
    firstImageUrl(record.previewImages) ||
    firstImageUrl(record.showcaseImages);

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
  const art = imageFromUnknown(prompt);
  const pricing = asRecord(record.pricing);
  const price = dollars(readNumber(record.priceUsdCents) ?? readNumber(record.price) ?? readNumber(pricing.pricePerGeneration));
  const id = String(readString(record.id) || readString(record._id) || `prompt_${index}`);
  const stats = asRecord(record.stats);
  const reviews = asRecord(stats.reviews);
  const previewImages = readArray(record.previewImages);
  const showcaseImages = readArray(record.showcaseImages);
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
    versions: [1, 2, 3, 4].map((offset) => imageFromUnknown(previewImages[offset] || showcaseImages[offset])),
    variables,
    promptTemplate: promptTemplateFrom(prompt, variables),
    // The prompt's own model or nothing; never an invented default.
    model: readString(record.model) || readString(record.aiModel) || "",
    publishedAt: listedAt || createdAt ? new Date(listedAt || createdAt || "").toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "",
  };
}

export function mapLegacyPromptToEnkiPrompt(prompt: unknown, index = 0) {
  return mapMarketplacePromptToEnkiPrompt(prompt, index);
}
