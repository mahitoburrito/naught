export const KITTY_KEYBOARD_SUPPORTED_FLAGS = 0x1f;
export const KITTY_KEYBOARD_STACK_MAX_DEPTH = 4096;
const KITTY_CSI_MAX_CHARS = 128;

const MODIFIER_KEY_CODES = new Map([
  ["ShiftLeft", 57441],
  ["ControlLeft", 57442],
  ["AltLeft", 57443],
  ["MetaLeft", 57444],
  ["ShiftRight", 57447],
  ["ControlRight", 57448],
  ["AltRight", 57449],
  ["MetaRight", 57450],
  ["CapsLock", 57358],
  ["NumLock", 57360],
]);

function defaultKeyboardEvent() {
  return {
    type: "keydown",
    key: "",
    code: "",
    shiftKey: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    repeat: false,
    isComposing: false,
  };
}

function oneCharacter(value = "") {
  const characters = Array.from(value);
  return characters.length === 1 ? characters[0] : undefined;
}

function boundedParameter(value = "", fallback = 0) {
  if (value === "") return fallback;
  if (!/^\d{1,5}$/.test(value)) return undefined;
  const parsed = Number(value);
  return parsed <= 65_535 ? parsed : undefined;
}

function modifierValue(event = defaultKeyboardEvent(), selfModifier = 0) {
  let modifiers = 1 + selfModifier;
  if (event.shiftKey && selfModifier !== 1) modifiers += 1;
  if (event.altKey && selfModifier !== 2) modifiers += 2;
  if (event.ctrlKey && selfModifier !== 4) modifiers += 4;
  if (event.metaKey && selfModifier !== 8) modifiers += 8;
  return modifiers;
}

function modifierSelfBit(code = "") {
  if (code.startsWith("Shift")) return 1;
  if (code.startsWith("Alt")) return 2;
  if (code.startsWith("Control")) return 4;
  if (code.startsWith("Meta")) return 8;
  return 0;
}

function printableBaseCode(event = defaultKeyboardEvent()) {
  if (/^Key[A-Z]$/.test(event.code)) return event.code.charCodeAt(3) + 32;
  if (/^Digit[0-9]$/.test(event.code)) return event.code.charCodeAt(5);
  const character = oneCharacter(event.key);
  if (!character) return undefined;
  if (/^[A-Z]$/.test(character)) return character.toLowerCase().codePointAt(0);
  return character.codePointAt(0);
}

function functionalKeyCode(event = defaultKeyboardEvent()) {
  switch (event.key) {
    case "Enter": return 13;
    case "Tab": return 9;
    case "Escape": return 27;
    case "Backspace": return 127;
    case " ": return 32;
  }
  const functionKey = /^F(1[3-9]|2\d|3[0-5])$/.exec(event.key);
  if (functionKey) return 57_363 + Number(functionKey[1]);
  return printableBaseCode(event);
}

function associatedText(event = defaultKeyboardEvent()) {
  if (event.type !== "keydown" || event.ctrlKey || event.metaKey) return undefined;
  const character = oneCharacter(event.key);
  if (!character || /[\u0000-\u001f\u007f-\u009f]/.test(character)) return undefined;
  return Array.from(event.key).map((value) => value.codePointAt(0)).join(":");
}

export function encodeKittyKeyboardEvent(
  event = defaultKeyboardEvent(),
  rawFlags = 0,
  isMac = false,
) {
  const flags = rawFlags & KITTY_KEYBOARD_SUPPORTED_FLAGS;
  if (!flags || event.isComposing || event.key === "Dead" || event.key === "Process" ||
    event.key === "Unidentified") return null;
  // On macOS, Cmd shortcuts (paste, copy, app shortcuts) belong to the app, as
  // in Terminal and iTerm. Encoding them as Super sent "super+v" alongside the
  // real paste, and Kitty-aware programs typed it as a literal "v".
  if (isMac && event.metaKey) return null;

  const reportEvents = (flags & 2) !== 0;
  const modifierCode = MODIFIER_KEY_CODES.get(event.code);
  if (modifierCode !== undefined) {
    if ((flags & 8) === 0 || (event.type === "keyup" && !reportEvents) ||
      (event.type !== "keydown" && event.type !== "keyup")) return null;
    const modifiers = modifierValue(event, modifierSelfBit(event.code));
    if (reportEvents) {
      const eventType = event.type === "keyup" ? 3 : event.repeat ? 2 : 1;
      return `\x1b[${modifierCode};${modifiers}:${eventType}u`;
    }
    return `\x1b[${modifierCode};${modifiers}u`;
  }

  if (event.type === "keyup" && !reportEvents) return null;
  if (event.type !== "keydown" && event.type !== "keyup") return null;

  const shiftedFunctional = event.shiftKey &&
    ["Enter", "Tab", "Backspace"].includes(event.key);
  const ambiguous = event.key === "Escape" || event.ctrlKey || event.metaKey ||
    (!isMac && event.altKey) || shiftedFunctional;
  const shouldEncode = (flags & 8) !== 0 || ((flags & 1) !== 0 && ambiguous);
  if (!shouldEncode) return null;

  const keyCode = functionalKeyCode(event);
  if (keyCode === undefined) return null;
  const shifted = (flags & 4) !== 0 && event.shiftKey
    ? oneCharacter(event.key)?.codePointAt(0)
    : undefined;
  const keyPart = shifted !== undefined && shifted !== keyCode
    ? `${keyCode}:${shifted}`
    : String(keyCode);
  const modifiers = modifierValue(event);
  const eventType = event.type === "keyup" ? 3 : event.repeat ? 2 : 1;
  const text = (flags & 16) !== 0 ? associatedText(event) : undefined;

  if (text !== undefined && event.type === "keydown") {
    const modifierPart = reportEvents && eventType !== 1
      ? `${modifiers}:${eventType}`
      : String(modifiers);
    return `\x1b[${keyPart};${modifierPart};${text}u`;
  }
  if (reportEvents && eventType !== 1) return `\x1b[${keyPart};${modifiers}:${eventType}u`;
  return modifiers > 1 ? `\x1b[${keyPart};${modifiers}u` : `\x1b[${keyPart}u`;
}

export class KittyKeyboardProtocol {
  enabled = true;
  primaryModeStack = [0];
  alternateModeStack = [0];
  alternateScreen = false;
  state = "ground";
  pending = "";
  controlStringAllowsBel = false;

  constructor(enabled = true) {
    this.enabled = enabled;
  }

  get flags() {
    const stack = this.activeModeStack();
    return stack[stack.length - 1] || 0;
  }

  get stackDepth() {
    return this.activeModeStack().length;
  }

  processOutput(data = "", sendResponse = (_response = "") => {}) {
    let output = "";
    for (const character of data) {
      const code = character.charCodeAt(0);
      switch (this.state) {
        case "ground":
          if (character === "\x1b") {
            this.pending = character;
            this.state = "escape";
          } else if (code === 0x9b) {
            this.pending = character;
            this.state = "csi";
          } else {
            output += character;
            if ([0x90, 0x98, 0x9d, 0x9e, 0x9f].includes(code)) {
              this.state = "control-string";
              this.controlStringAllowsBel = code === 0x9d;
            }
          }
          break;
        case "escape":
          if (character === "[") {
            this.pending += character;
            this.state = "csi";
          } else if (["]", "P", "X", "^", "_"].includes(character)) {
            output += this.pending + character;
            this.pending = "";
            this.state = "control-string";
            this.controlStringAllowsBel = character === "]";
          } else if (character === "\x1b") {
            output += this.pending;
            this.pending = character;
          } else {
            output += this.pending + character;
            this.pending = "";
            this.state = "ground";
          }
          break;
        case "csi":
          if (character === "\x1b") {
            output += this.pending;
            this.pending = character;
            this.state = "escape";
            break;
          }
          this.pending += character;
          if (this.pending.length > KITTY_CSI_MAX_CHARS) {
            output += this.pending;
            this.pending = "";
            this.state = "csi-passthrough";
          } else if (code === 0x18 || code === 0x1a) {
            output += this.pending;
            this.pending = "";
            this.state = "ground";
          } else if (code >= 0x40 && code <= 0x7e) {
            const sequence = this.pending;
            this.pending = "";
            this.state = "ground";
            this.observeAlternateScreen(sequence);
            if (!this.consumeKittySequence(sequence, sendResponse)) output += sequence;
          }
          break;
        case "csi-passthrough":
          if (character === "\x1b") {
            this.pending = character;
            this.state = "escape";
          } else {
            output += character;
            if (code === 0x18 || code === 0x1a || (code >= 0x40 && code <= 0x7e)) {
              this.state = "ground";
            }
          }
          break;
        case "control-string":
          output += character;
          if (code === 0x9c || (this.controlStringAllowsBel && character === "\x07")) {
            this.state = "ground";
          } else if (character === "\x1b") {
            this.state = "control-string-escape";
          }
          break;
        case "control-string-escape":
          output += character;
          if (character === "\\" || code === 0x9c ||
            (this.controlStringAllowsBel && character === "\x07")) {
            this.state = "ground";
          } else if (character !== "\x1b") {
            this.state = "control-string";
          }
          break;
      }
    }
    return output;
  }

  reset() {
    this.primaryModeStack = [0];
    this.alternateModeStack = [0];
    this.alternateScreen = false;
    this.state = "ground";
    this.pending = "";
    this.controlStringAllowsBel = false;
  }

  activeModeStack() {
    return this.alternateScreen ? this.alternateModeStack : this.primaryModeStack;
  }

  setActiveFlags(flags = 0) {
    const stack = this.activeModeStack();
    stack[stack.length - 1] = flags & KITTY_KEYBOARD_SUPPORTED_FLAGS;
  }

  pushFlags(flags = 0) {
    const stack = this.activeModeStack();
    if (stack.length >= KITTY_KEYBOARD_STACK_MAX_DEPTH) stack.shift();
    stack.push(flags & KITTY_KEYBOARD_SUPPORTED_FLAGS);
  }

  popFlags(count = 1) {
    const stack = this.activeModeStack();
    const removals = Math.min(Math.max(0, count), Math.max(0, stack.length - 1));
    stack.splice(stack.length - removals, removals);
  }

  consumeKittySequence(sequence = "", sendResponse = (_response = "") => {}) {
    const body = sequence.startsWith("\x1b[") ? sequence.slice(2, -1) : sequence.slice(1, -1);
    if (!sequence.endsWith("u")) return false;
    const kittyCommand = body === "?" || /^=\d{0,5}(?:;\d{0,5})?$/.test(body) ||
      /^>\d{0,5}$/.test(body) || /^<\d{0,5}$/.test(body);
    if (!this.enabled && kittyCommand) return true;
    if (body === "?") {
      sendResponse(`\x1b[?${this.flags}u`);
      return true;
    }

    let match = /^=(\d{0,5})(?:;(\d{0,5}))?$/.exec(body);
    if (match) {
      const flags = boundedParameter(match[1], 0);
      const applyMode = boundedParameter(match[2] || "", 1);
      if (flags === undefined || ![1, 2, 3].includes(applyMode || 0)) return true;
      if (applyMode === 1) this.setActiveFlags(flags);
      else if (applyMode === 2) this.setActiveFlags(this.flags | flags);
      else this.setActiveFlags(this.flags & ~flags);
      return true;
    }

    match = /^>(\d{0,5})$/.exec(body);
    if (match) {
      const flags = boundedParameter(match[1], 0);
      if (flags !== undefined) this.pushFlags(flags);
      return true;
    }

    match = /^<(\d{0,5})$/.exec(body);
    if (match) {
      const count = boundedParameter(match[1], 1);
      if (count !== undefined) this.popFlags(count);
      return true;
    }
    return false;
  }

  observeAlternateScreen(sequence = "") {
    const body = sequence.startsWith("\x1b[") ? sequence.slice(2, -1) : sequence.slice(1, -1);
    const final = sequence.slice(-1);
    if ((final !== "h" && final !== "l") || !/^\?(?:\d+)(?:;\d+)*$/.test(body)) return;
    const hasAlternateScreen = body.slice(1).split(";").some((value) =>
      value === "47" || value === "1047" || value === "1049"
    );
    if (!hasAlternateScreen) return;
    if (final === "h" && !this.alternateScreen) {
      this.alternateScreen = true;
      this.alternateModeStack = [0];
    } else if (final === "l") {
      this.alternateScreen = false;
    }
  }
}
