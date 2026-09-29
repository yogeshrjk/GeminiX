// Lucide icon node data imported directly from the installed lucide-react
// package. Each icon module exports `__iconNode` — the same SVG node data lucide
// uses to render the icon — so we serialize it to a static SVG string without
// pulling a React runtime into the webview bundle.
import { __iconNode as searchNode } from "lucide-react/dist/esm/icons/search.mjs";
import { __iconNode as bookOpenNode } from "lucide-react/dist/esm/icons/book-open.mjs";
import { __iconNode as lightbulbNode } from "lucide-react/dist/esm/icons/lightbulb.mjs";
import { __iconNode as imageNode } from "lucide-react/dist/esm/icons/image.mjs";
import { __iconNode as volume2Node } from "lucide-react/dist/esm/icons/volume-2.mjs";
import { __iconNode as volumeXNode } from "lucide-react/dist/esm/icons/volume-x.mjs";
import { __iconNode as brainNode } from "lucide-react/dist/esm/icons/brain.mjs";
import { __iconNode as fileTextNode } from "lucide-react/dist/esm/icons/file-text.mjs";
import { __iconNode as micNode } from "lucide-react/dist/esm/icons/mic.mjs";
import { __iconNode as micOffNode } from "lucide-react/dist/esm/icons/mic-off.mjs";
import { __iconNode as castNode } from "lucide-react/dist/esm/icons/cast.mjs";
import { __iconNode as squareNode } from "lucide-react/dist/esm/icons/square.mjs";
import { __iconNode as pencilNode } from "lucide-react/dist/esm/icons/pencil.mjs";
import { __iconNode as sendNode } from "lucide-react/dist/esm/icons/send.mjs";
import { __iconNode as refreshCwNode } from "lucide-react/dist/esm/icons/refresh-cw.mjs";
import { __iconNode as copyNode } from "lucide-react/dist/esm/icons/copy.mjs";
import { __iconNode as checkNode } from "lucide-react/dist/esm/icons/check.mjs";
import { __iconNode as share2Node } from "lucide-react/dist/esm/icons/share-2.mjs";

type LucideNode = ReadonlyArray<
  readonly [tag: string, attributes: Readonly<Record<string, string | number>>]
>;

const ICON_NODES = {
  search: searchNode,
  "book-open": bookOpenNode,
  lightbulb: lightbulbNode,
  image: imageNode,
  "volume-2": volume2Node,
  "volume-x": volumeXNode,
  brain: brainNode,
  "file-text": fileTextNode,
  mic: micNode,
  "mic-off": micOffNode,
  cast: castNode,
  square: squareNode,
  pencil: pencilNode,
  send: sendNode,
  "refresh-cw": refreshCwNode,
  copy: copyNode,
  check: checkNode,
  "share-2": share2Node
} as const;

export type LucideIconName = keyof typeof ICON_NODES;

const SVG_ATTRIBUTES =
  'xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';

export function lucideIconSvg(name: LucideIconName, size = 16): string {
  const node = ICON_NODES[name] as LucideNode;
  const children = node
    .map(([tag, attributes]) => {
      const attrs = Object.entries(attributes)
        .filter(([key]) => key !== "key")
        .map(([key, value]) => `${key}="${escapeAttribute(String(value))}"`)
        .join(" ");
      return `<${tag} ${attrs}></${tag}>`;
    })
    .join("");
  return (
    `<svg ${SVG_ATTRIBUTES} width="${size}" height="${size}" ` +
    `class="lucide lucide-${name}" aria-hidden="true">${children}</svg>`
  );
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}
