/* eslint-disable no-restricted-globals */
import { wait } from "zotero-plugin-toolkit";
import { computeFont } from "../utils/font";

import type {
  PDFPage,
  CanvasGraphics,
  InternalRenderTask,
  Glyph,
} from "./typings/pdfViewer";

declare const PDFViewerApplication: _ZoteroTypes.Reader.PDFViewerApplication;

declare const pdfjsLib: _ZoteroTypes.Reader.pdfjs;

let intentStatesPrototype: any;

let firstRenderTriggered = false;

let isWordBroken = false;

type BionicColorPair = {
  boldColor: string;
  lightColor: string;
};

type HighlightTerm = {
  words: string[];
  colors: BionicColorPair;
  matchNormalizedWords?: boolean;
};

const bionicIntensityAdjustments: Record<
  string,
  { opacityContrastOffset: number; weightContrastOffset: number }
> = {
  subtle: { opacityContrastOffset: -1, weightContrastOffset: -1 },
  normal: { opacityContrastOffset: 0, weightContrastOffset: 0 },
  strong: { opacityContrastOffset: 1, weightContrastOffset: 1 },
};

const bionicColorContrastIntensity: Record<
  string,
  BionicColorPair & { weightContrast: number }
> = {
  subtle: {
    boldColor: "#3f3f3f",
    lightColor: "#8f8f8f",
    weightContrast: 1,
  },
  normal: {
    boldColor: "#1f1f1f",
    lightColor: "#8a8a8a",
    weightContrast: 2,
  },
  strong: {
    boldColor: "#000000",
    lightColor: "#a0a0a0",
    weightContrast: 3,
  },
};

const structureWordColors = {
  contrast: { boldColor: "#7F00FF", lightColor: "#E0B0FF" },
  cause: { boldColor: "#2323FF", lightColor: "#8FD9FB" },
  customTerm: { boldColor: "#FF1A74", lightColor: "#FFA6C9" },
};

const structureWordTerms: HighlightTerm[] = [
  ...makeHighlightTerms(
    [
      "but",
      "however",
      "although",
      "though",
      "whereas",
      "nevertheless",
      "nonetheless",
      "yet",
      "in contrast",
      "on the other hand",
      "rather than",
      "instead",
      "instead of",
    ],
    structureWordColors.contrast,
  ),
  ...makeHighlightTerms(
    [
      "because",
      "because of",
      "due to",
      "therefore",
      "thus",
      "hence",
      "consequently",
      "as a result",
      "so",
      "since",
    ],
    structureWordColors.cause,
  ),
].sort(sortHighlightTermsByLength);

function main() {
  patchIntentStatesGet();

  // If the first render is not triggered in 3 seconds, trigger a refresh again
  setTimeout(() => {
    if (!firstRenderTriggered) {
      refresh();
    }
  }, 3000);
}

main();

async function patchIntentStatesGet(pageIndex = 0) {
  await PDFViewerApplication?.pdfViewer?.firstPagePromise;
  await wait.waitUtilAsync(
    () =>
      !!PDFViewerApplication?.pdfViewer?._pages &&
      !!PDFViewerApplication?.pdfViewer?._pages[pageIndex],
    100,
    10000,
  );
  const page = PDFViewerApplication.pdfViewer!._pages![pageIndex] as PDFPage;
  // @ts-ignore Prototypes are not typed
  intentStatesPrototype = page.pdfPage._intentStates.__proto__;
  const original_get = intentStatesPrototype.get;
  intentStatesPrototype.__original_get = original_get;
  intentStatesPrototype.get = function (intent: any) {
    const ret = original_get.apply(this, [intent]);
    if (ret && typeof ret === "object" && ret.renderTasks) {
      _log("Intent", intent, ret);
      patchRenderTasksAdd(ret.renderTasks);
    }
    return ret;
  };
  // Refresh the page to apply the patch
  refresh();
}

function unPatchIntentStatesGet() {
  if (intentStatesPrototype.__original_get) {
    intentStatesPrototype.get = intentStatesPrototype.__original_get;
    delete intentStatesPrototype.__original_get;
  }
}

function patchRenderTasksAdd(renderTasks: Set<InternalRenderTask>) {
  const original_add = renderTasks.add;
  renderTasks.add = function (renderTask) {
    _log("Adding render task", renderTask);
    wait
      .waitUtilAsync(() => renderTask.gfx, 100, 10000)
      .then(() => {
        patchCanvasGraphicsShowText(renderTask.gfx.__proto__);
        renderTasks.add = original_add;
        unPatchIntentStatesGet();
      });
    return original_add.apply(this, [renderTask]);
  };
}

function patchCanvasGraphicsShowText(
  canvasGraphicsPrototype: typeof CanvasGraphics & {
    __showTextPatched?: boolean;
    ctx: CanvasRenderingContext2D;
  },
) {
  if (canvasGraphicsPrototype.__showTextPatched) {
    return;
  }
  firstRenderTriggered = true;
  canvasGraphicsPrototype.__showTextPatched = true;
  // @ts-ignore Runtime generated method on prototype
  const original_showText = canvasGraphicsPrototype[pdfjsLib.OPS.showText];
  _log("Patching showText", canvasGraphicsPrototype);
  // @ts-ignore Runtime generated method on prototype
  canvasGraphicsPrototype[pdfjsLib.OPS.showText] = function (glyphs: Glyph[]) {
    if (!window.__BIONIC_READER_ENABLED) {
      return original_showText.apply(this, [glyphs]);
    }

    const intensity =
      bionicIntensityAdjustments[window.__BIONIC_INTENSITY || "normal"] ||
      bionicIntensityAdjustments.normal;
    const useColorContrast =
      window.__BIONIC_CONTRAST_MODE === "colorContrast";
    const colorContrastIntensity =
      bionicColorContrastIntensity[window.__BIONIC_INTENSITY || "normal"] ||
      bionicColorContrastIntensity.normal;
    const opacityContrast = useColorContrast
      ? 1
      : Math.max(
          (window.__BIONIC_OPACITY_CONTRAST || 1) +
            intensity.opacityContrastOffset,
          1,
        );

    const weightContrast = useColorContrast
      ? colorContrastIntensity.weightContrast
      : Math.max(
          (window.__BIONIC_WEIGHT_CONTRAST || 1) +
            intensity.weightContrastOffset,
          1,
        );
    const weightOffset = window.__BIONIC_WEIGHT_OFFSET || 0;

    const savedFont = this.ctx.font;
    const savedOpacity = this.ctx.globalAlpha;
    const savedFillStyle = this.ctx.fillStyle;
    const savedStrokeStyle = this.ctx.strokeStyle;

    const { bold, light } = computeFont({
      font: savedFont,
      alpha: savedOpacity,
      opacityContrast,
      weightContrast,
      weightOffset,
    });

    const newGlyphData = computeBionicGlyphs(glyphs);
    const highlightColorsByGlyph =
      useColorContrast &&
      (window.__BIONIC_STRUCTURE_WORD_COLORS_ENABLED ||
        window.__BIONIC_CUSTOM_TERM_COLORS_ENABLED)
        ? computeHighlightColors(glyphs)
        : undefined;

    for (const { glyphs: newG, isBold } of newGlyphData) {
      this.ctx.font = isBold ? bold.font : light.font;
      if (useColorContrast) {
        const colors =
          getHighlightColors(newG, highlightColorsByGlyph) ||
          colorContrastIntensity;
        const color = isBold ? colors.boldColor : colors.lightColor;
        this.ctx.fillStyle = color;
        this.ctx.strokeStyle = color;
      }
      // If use greater contrast is enabled, set text opacity to less than 1
      if (opacityContrast > 1 && !isBold) {
        this.ctx.globalAlpha = light.alpha;
      }
      original_showText.apply(this, [newG]);
      this.ctx.font = savedFont;
      this.ctx.globalAlpha = savedOpacity;
      this.ctx.fillStyle = savedFillStyle;
      this.ctx.strokeStyle = savedStrokeStyle;
    }

    return undefined;
  };
  _log("Patched showText", window.__BIONIC_READER_ENABLED);
  if (window.__BIONIC_READER_ENABLED) {
    refresh();
  }
}

function computeBionicGlyphs(glyphs: Glyph[]) {
  let wordStartIdx = NaN;
  let wordEndIdx = NaN;
  let word = "";
  const newGlyphData: {
    glyphs: Glyph[];
    isBold: boolean;
  }[] = [];

  const parsingOffset = window.__BIONIC_PARSING_OFFSET || 0;

  // From text-vide
  const CONVERTIBLE_REGEX = /(\p{L}|\p{Nd})*\p{L}(\p{L}|\p{Nd})*/u;

  const NON_VOWELS_REGEX = /[^aeiou]/gi;

  // Use a regex to match all non-alphanumeric characters, e.g. space, punctuation, etc.
  // But should not match other unicode characters like emojis or cjks
  const SEPARATOR_REGEX = /[\p{P}\p{S}\p{Z}]/u;

  function getStr(glyph: Glyph) {
    if (typeof glyph === "number") {
      if (glyph < -100) {
        return " ";
      } else {
        return "<EMPTY>";
      }
    }
    return glyph.unicode;
  }

  for (let i = 0; i < glyphs.length; i++) {
    const glyph = glyphs[i];
    const str = getStr(glyph);
    const isWordSeparator = SEPARATOR_REGEX.test(str);

    const isWordStarted = !Number.isNaN(wordStartIdx);
    if (isWordStarted) {
      if (isWordSeparator || i === glyphs.length - 1) {
        // If the word has started and we encounter a space, the word has ended
        wordEndIdx = i;
        word += str;
        _log(`Word ended: ${wordStartIdx} ${wordEndIdx}`);
      } else {
        // If the word has started and we encounter a non-space, the word has not ended
        word += str;
        continue;
      }
    } else {
      if (!isWordSeparator) {
        // If the word has not started and we encounter a non-space, the word has started
        wordStartIdx = i;
        word += str;
        _log(`Word started: ${wordStartIdx}`);
      } else {
        // If the word has not started and we encounter a space, the word has not started
        newGlyphData.push({
          glyphs: glyphs.slice(i, i + 1),
          isBold: false,
        });
        continue;
      }
    }
    const isWordEnded = isWordStarted && !Number.isNaN(wordEndIdx);
    if (!isWordEnded) {
      continue;
    }

    // If the word has ended, bolden the first alphabet of the word
    // const word = showTextArgs.slice(wordStartIdx, wordEndIdx).map((arg) => {
    //     return arg.unicode;
    // }).join("");
    _log(`Boldening word: ${wordStartIdx} ${wordEndIdx}`, word);

    word = word.replace(/<EMPTY>/g, "\u2060");

    if (wordEndIdx === wordStartIdx || !CONVERTIBLE_REGEX.test(word)) {
      newGlyphData.push({
        glyphs: glyphs.slice(wordStartIdx, wordEndIdx + 1),
        isBold: false,
      });
      wordStartIdx = NaN;
      wordEndIdx = NaN;
      word = "";
      continue;
    }

    let boldNumber = 1;

    const wordLength = wordEndIdx + 1 - wordStartIdx;
    const isPreviousWordBroken = isWordBroken;
    isWordBroken =
      word.endsWith("\u2060") && wordLength >= 1 && wordLength <= 10;
    // If the word ends with a zero-width space, it may be broken
    if (isPreviousWordBroken && !isWordBroken) {
      // If the previous word was broken and the current word is not broken, skip boldening
      boldNumber = 0;
      isWordBroken = false;
    } else if (isWordBroken) {
      // If the word is broken, bolden the entire word as it is the first part
      _log("The word may be broken", word.slice(wordStartIdx, wordEndIdx + 1));
      boldNumber = wordLength;
    } else if (wordLength < 4) {
      boldNumber = 1;
    } else {
      boldNumber = Math.ceil(wordLength / 2);

      if (boldNumber > 6) {
        // Find the closest non-vowel character to the bold number
        const nonVowels = word.matchAll(NON_VOWELS_REGEX);
        const closestMatch = Array.from(nonVowels).sort((a, b) => {
          return (
            Math.abs(a.index! - boldNumber) - Math.abs(b.index! - boldNumber)
          );
        })[0];
        if (closestMatch && Math.abs(closestMatch.index - boldNumber) < 2) {
          boldNumber = closestMatch.index! + 1;
        }
      }
    }

    boldNumber += parsingOffset;

    // Clamp the bold number to the word length
    boldNumber = Math.max(Math.min(boldNumber, wordLength), 1);

    _log("Word length", wordLength, boldNumber);

    newGlyphData.push({
      glyphs: glyphs.slice(wordStartIdx, wordStartIdx + boldNumber),
      isBold: true,
    });

    if (wordStartIdx + boldNumber <= wordEndIdx) {
      newGlyphData.push({
        glyphs: glyphs.slice(wordStartIdx + boldNumber, wordEndIdx + 1),
        isBold: false,
      });
    }

    wordStartIdx = NaN;
    wordEndIdx = NaN;
    word = "";
  }

  // If the last word has not ended, push it
  if (!Number.isNaN(wordStartIdx)) {
    newGlyphData.push({
      glyphs: glyphs.slice(wordStartIdx, wordStartIdx + glyphs.length),
      isBold: false,
    });
  }
  return newGlyphData;
}

function makeHighlightTerms(terms: string[], colors: BionicColorPair) {
  return terms
    .map((term) => normalizeTerm(term))
    .filter((words) => words.length)
    .map((words) => ({ words, colors }));
}

function normalizeTerm(term: string) {
  return term
    .trim()
    .toLocaleLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function parseCustomHighlightTerms() {
  return String(window.__BIONIC_CUSTOM_HIGHLIGHT_TERMS || "")
    .split(/\r?\n/)
    .map((term) => normalizeTerm(term))
    .filter((words) => words.length)
    .map((words) => ({
      words,
      colors: structureWordColors.customTerm,
      matchNormalizedWords: true,
    }))
    .sort(sortHighlightTermsByLength);
}

function sortHighlightTermsByLength(a: HighlightTerm, b: HighlightTerm) {
  return b.words.length - a.words.length;
}

function singularizeCustomTermWord(word: string) {
  if (word.length > 4 && word.endsWith("ies")) {
    return `${word.slice(0, -3)}y`;
  }
  if (word.length > 4 && /(ches|shes|xes|zes|sses|oes)$/.test(word)) {
    return word.slice(0, -2);
  }
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) {
    return word.slice(0, -1);
  }
  return word;
}

function customTermWordMatches(tokenWord: string, termWord: string) {
  if (tokenWord === termWord) {
    return true;
  }
  return (
    singularizeCustomTermWord(tokenWord) === termWord ||
    singularizeCustomTermWord(tokenWord) === singularizeCustomTermWord(termWord)
  );
}

function computeHighlightColors(glyphs: Glyph[]) {
  const colorsByGlyph = new Map<Glyph, BionicColorPair>();
  const WORD_CHAR_REGEX = /^[A-Za-z0-9]+$/;
  const tokens: { word: string; glyphs: Glyph[] }[] = [];
  let token = "";
  let tokenGlyphs: Glyph[] = [];

  function flushToken() {
    if (token) {
      tokens.push({
        word: token.toLocaleLowerCase(),
        glyphs: tokenGlyphs,
      });
    }
    token = "";
    tokenGlyphs = [];
  }

  for (const glyph of glyphs) {
    const str = typeof glyph === "number" ? " " : glyph.unicode;
    if (WORD_CHAR_REGEX.test(str)) {
      token += str;
      tokenGlyphs.push(glyph);
    } else {
      flushToken();
    }
  }
  flushToken();

  if (window.__BIONIC_STRUCTURE_WORD_COLORS_ENABLED) {
    applyHighlightTerms(tokens, structureWordTerms, colorsByGlyph);
  }
  if (window.__BIONIC_CUSTOM_TERM_COLORS_ENABLED) {
    applyHighlightTerms(tokens, parseCustomHighlightTerms(), colorsByGlyph);
  }

  return colorsByGlyph;
}

function applyHighlightTerms(
  tokens: { word: string; glyphs: Glyph[] }[],
  terms: HighlightTerm[],
  colorsByGlyph: Map<Glyph, BionicColorPair>,
) {
  const matchedTokenIndexes = new Set<number>();
  for (const term of terms) {
    for (let i = 0; i <= tokens.length - term.words.length; i++) {
      const tokenIndexes = term.words.map((_, offset) => i + offset);
      if (
        tokenIndexes.some((tokenIndex) => matchedTokenIndexes.has(tokenIndex))
      ) {
        continue;
      }
      const matches = term.words.every((word, offset) => {
        const tokenWord = tokens[i + offset].word;
        return term.matchNormalizedWords
          ? customTermWordMatches(tokenWord, word)
          : tokenWord === word;
      });
      if (!matches) {
        continue;
      }
      tokenIndexes.forEach((tokenIndex) => {
        matchedTokenIndexes.add(tokenIndex);
        tokens[tokenIndex].glyphs.forEach((glyph) => {
          colorsByGlyph.set(glyph, term.colors);
        });
      });
    }
  }
}

function getHighlightColors(
  glyphs: Glyph[],
  colorsByGlyph?: Map<Glyph, BionicColorPair>,
) {
  if (!colorsByGlyph) {
    return undefined;
  }
  for (const glyph of glyphs) {
    const colors = colorsByGlyph.get(glyph);
    if (colors) {
      return colors;
    }
  }
  return undefined;
}

function refresh() {
  PDFViewerApplication.pdfViewer?.cleanup();
  PDFViewerApplication.pdfViewer?.refresh();
}

function _log(...args: any[]) {
  if (__env__ === "development") {
    console.log("[Bionic for Zotero]", ...args);
  }
}
