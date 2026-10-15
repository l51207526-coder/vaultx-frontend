// Small local QR encoder for deposit addresses (QR Code version 3, error correction L).
// It handles the project's ASCII EVM and TRON wallet addresses without a remote service.
(function () {
  "use strict";

  const SIZE = 29;
  const DATA_CODEWORDS = 55;
  const ECC_CODEWORDS = 15;

  function multiply(a, b) {
    let result = 0;
    while (b) {
      if (b & 1) result ^= a;
      a <<= 1;
      if (a & 0x100) a ^= 0x11d;
      b >>>= 1;
    }
    return result;
  }

  function makeGenerator(degree) {
    let polynomial = [1];
    let root = 1;
    for (let i = 0; i < degree; i += 1) {
      const next = Array(polynomial.length + 1).fill(0);
      polynomial.forEach((coefficient, index) => {
        next[index] ^= coefficient;
        next[index + 1] ^= multiply(coefficient, root);
      });
      polynomial = next;
      root = multiply(root, 2);
    }
    return polynomial;
  }

  function appendBits(target, value, length) {
    for (let i = length - 1; i >= 0; i -= 1) target.push((value >>> i) & 1);
  }

  function encodeData(text) {
    const bytes = Array.from(new TextEncoder().encode(text));
    if (bytes.length > 53) throw new Error("This QR code supports up to 53 UTF-8 bytes.");

    const bits = [];
    appendBits(bits, 0b0100, 4); // Byte mode
    appendBits(bits, bytes.length, 8);
    bytes.forEach((byte) => appendBits(bits, byte, 8));
    const capacity = DATA_CODEWORDS * 8;
    for (let i = 0; i < Math.min(4, capacity - bits.length); i += 1) bits.push(0);
    while (bits.length % 8) bits.push(0);

    const data = [];
    for (let i = 0; i < bits.length; i += 8) {
      data.push(bits.slice(i, i + 8).reduce((value, bit) => (value << 1) | bit, 0));
    }
    for (let pad = 0; data.length < DATA_CODEWORDS; pad += 1) data.push(pad % 2 ? 0x11 : 0xec);

    const generator = makeGenerator(ECC_CODEWORDS);
    const remainder = Array(ECC_CODEWORDS).fill(0);
    for (const byte of data) {
      const factor = byte ^ remainder[0];
      for (let i = 0; i < ECC_CODEWORDS - 1; i += 1) {
        remainder[i] = remainder[i + 1] ^ multiply(generator[i + 1], factor);
      }
      remainder[ECC_CODEWORDS - 1] = multiply(generator[ECC_CODEWORDS], factor);
    }
    return data.concat(remainder);
  }

  function makeMatrix(codewords, mask) {
    const modules = Array.from({ length: SIZE }, () => Array(SIZE).fill(false));
    const functions = Array.from({ length: SIZE }, () => Array(SIZE).fill(false));
    const setFunction = (x, y, dark) => {
      if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return;
      modules[y][x] = Boolean(dark);
      functions[y][x] = true;
    };

    function drawFinder(centerX, centerY) {
      for (let dy = -1; dy <= 7; dy += 1) {
        for (let dx = -1; dx <= 7; dx += 1) {
          const x = centerX + dx;
          const y = centerY + dy;
          const inside = dx >= 0 && dx <= 6 && dy >= 0 && dy <= 6;
          const dark = inside && (dx === 0 || dx === 6 || dy === 0 || dy === 6 || (dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4));
          setFunction(x, y, dark);
        }
      }
    }

    drawFinder(0, 0);
    drawFinder(SIZE - 7, 0);
    drawFinder(0, SIZE - 7);

    for (let i = 8; i < SIZE - 8; i += 1) {
      setFunction(i, 6, i % 2 === 0);
      setFunction(6, i, i % 2 === 0);
    }

    // Version 3 alignment pattern. The other two centers overlap finder patterns.
    for (let dy = -2; dy <= 2; dy += 1) {
      for (let dx = -2; dx <= 2; dx += 1) {
        setFunction(22 + dx, 22 + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }

    const drawFormat = () => {
      const formatData = (0b01 << 3) | mask; // Error correction L
      let remainder = formatData << 10;
      for (let bit = 14; bit >= 10; bit -= 1) {
        if (((remainder >>> bit) & 1) !== 0) remainder ^= 0x537 << (bit - 10);
      }
      const format = ((formatData << 10) | remainder) ^ 0x5412;
      const bitAt = (index) => ((format >>> index) & 1) !== 0;

      for (let i = 0; i <= 5; i += 1) setFunction(8, i, bitAt(i));
      setFunction(8, 7, bitAt(6));
      setFunction(8, 8, bitAt(7));
      setFunction(7, 8, bitAt(8));
      for (let i = 9; i < 15; i += 1) setFunction(14 - i, 8, bitAt(i));
      for (let i = 0; i < 8; i += 1) setFunction(SIZE - 1 - i, 8, bitAt(i));
      for (let i = 8; i < 15; i += 1) setFunction(8, SIZE - 15 + i, bitAt(i));
      setFunction(8, SIZE - 8, true); // Fixed dark module
    };
    drawFormat(); // Reserve format locations before placing data.

    const dataBits = [];
    codewords.forEach((byte) => appendBits(dataBits, byte, 8));
    let bitIndex = 0;
    for (let right = SIZE - 1; right >= 1; right -= 2) {
      if (right === 6) right -= 1;
      for (let vert = 0; vert < SIZE; vert += 1) {
        const y = ((right + 1) & 2) === 0 ? SIZE - 1 - vert : vert;
        for (let offset = 0; offset < 2; offset += 1) {
          const x = right - offset;
          if (functions[y][x]) continue;
          const bit = bitIndex < dataBits.length ? dataBits[bitIndex] : 0;
          bitIndex += 1;
          modules[y][x] = Boolean(bit ^ (((x + y) % 2 === 0) ? 1 : 0)); // Mask pattern 0
        }
      }
    }
    drawFormat();
    return modules;
  }

  window.renderDepositQr = function (text, canvas) {
    if (!canvas) return;
    const codewords = encodeData(text);
    const matrix = makeMatrix(codewords, 0);
    const scale = 10;
    const quietZone = 4;
    const fullSize = (SIZE + quietZone * 2) * scale;
    canvas.width = fullSize;
    canvas.height = fullSize;
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    canvas.style.imageRendering = "pixelated";
    canvas.setAttribute("role", "img");
    canvas.setAttribute("aria-label", `QR code for deposit address ${text}`);
    const context = canvas.getContext("2d");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, fullSize, fullSize);
    context.fillStyle = "#000000";
    matrix.forEach((row, y) => row.forEach((dark, x) => {
      if (dark) context.fillRect((x + quietZone) * scale, (y + quietZone) * scale, scale, scale);
    }));
  };
})();
