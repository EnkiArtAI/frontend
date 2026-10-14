import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, mkdir, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createFromRoot } from "codama";
import { rootNodeFromAnchor } from "@codama/nodes-from-anchor";
import { renderVisitor } from "@codama/renderers-js";

const root = fileURLToPath(new URL("../", import.meta.url));
const client = path.join(root, "lib/payments/escrow");
const idlBytes = await readFile(path.join(client, "idl/enki_escrow.json"));
const provenance = JSON.parse(await readFile(path.join(client, "idl/provenance.json"), "utf8"));
if (createHash("sha256").update(idlBytes).digest("hex") !== provenance.idlSha256) {
  throw new Error("The Anchor interface does not match its verified build artifact.");
}

async function files(directory, prefix = "") {
  const entries = await readdir(directory, { withFileTypes: true });
  const found = await Promise.all(entries.map(async (entry) => {
    const relative = path.join(prefix, entry.name);
    return entry.isDirectory() ? files(path.join(directory, entry.name), relative) : [relative];
  }));
  return found.flat().sort();
}

const temporary = await mkdtemp(path.join(tmpdir(), "enki-escrow-codegen-"));
try {
  const output = path.join(temporary, "generated");
  const codama = createFromRoot(rootNodeFromAnchor(JSON.parse(idlBytes.toString("utf8"))));
  await codama.accept(renderVisitor(temporary, {
    generatedFolder: "generated",
    syncPackageJson: false,
    kitImportStrategy: "rootOnly",
    erasableSyntax: true,
    // Rust's ConfigArgs would collide with the account encoder's default name.
    nameTransformers: { dataArgsType: (name, { pascalCase }) => `${pascalCase(name)}Input` },
    prettierOptions: { tabWidth: 2, singleQuote: false },
  }));
  const generated = await files(output);
  const destination = path.join(client, "generated");
  if (process.argv.includes("--check")) {
    const committed = await files(destination);
    if (JSON.stringify(generated) !== JSON.stringify(committed)) {
      throw new Error("Escrow generated files differ. Run npm run escrow:generate.");
    }
    for (const relative of generated) {
      if (!(await readFile(path.join(output, relative))).equals(await readFile(path.join(destination, relative)))) {
        throw new Error(`Escrow generated file differs: ${relative}. Run npm run escrow:generate.`);
      }
    }
    console.log(`Verified ${generated.length} generated Escrow files against the compiled Anchor interface.`);
  } else {
    await mkdir(destination, { recursive: true });
    for (const relative of generated) {
      await mkdir(path.dirname(path.join(destination, relative)), { recursive: true });
      await copyFile(path.join(output, relative), path.join(destination, relative));
    }
    // Remove obsolete files only within this generated directory.
    for (const relative of await files(destination)) {
      if (!generated.includes(relative)) await rm(path.join(destination, relative));
    }
    console.log(`Generated ${generated.length} Escrow files from the compiled Anchor interface.`);
  }
} finally {
  await rm(temporary, { recursive: true, force: true });
}
