interface IntegerRead {
  value: number;
  next: number;
}

/** Checked counterpart to BinaryReader.integer(), whose flex reader is permissive at EOF. */
function readInteger(body: Uint8Array, start: number): IntegerRead | undefined {
  let value = 0;
  let pos = start;
  for (let bytes = 0; bytes < 5; bytes += 1) {
    if (pos >= body.length) return undefined;
    const byte = body[pos++];
    if (bytes === 4 && (body[start] & 0x7f) > 0x0f) return undefined;
    value = (value << 7) | (byte & 0x7f);
    if ((byte & 0x80) === 0) {
      const used = pos - start;
      const unsigned = value >>> 0;
      const minimum = used === 1 ? 0 : 2 ** (7 * (used - 1));
      if (unsigned < minimum) return undefined;
      return { value: value | 0, next: pos };
    }
  }
  return undefined;
}

/**
 * Decode the inner ProfileData<bool> body after ObjectGraph removes the outer
 * LengthPrefixed framing. The installed API writes count, then Sooid+bool
 * tuples; lookup returns the first profile match or false when none exists.
 */
export function decodeBoolProfileData(body: Buffer, profileId: Buffer): boolean | undefined {
  const countRead = readInteger(body, 0);
  if (!countRead || countRead.value < 0) return undefined;

  let pos = countRead.next;
  if (countRead.value > Math.floor((body.length - pos) / 2)) return undefined;
  let matched = false;
  let matchedValue = false;

  for (let index = 0; index < countRead.value; index += 1) {
    const lengthRead = readInteger(body, pos);
    if (!lengthRead || lengthRead.value < 0) return undefined;
    pos = lengthRead.next;
    const remaining = body.length - pos;
    if (lengthRead.value > remaining - 1) return undefined;

    const key = body.subarray(pos, pos + lengthRead.value);
    pos += lengthRead.value;
    const rawValue = body[pos++];
    if (rawValue !== 0 && rawValue !== 1) return undefined;
    if (!matched && key.equals(profileId)) {
      matched = true;
      matchedValue = rawValue === 1;
    }
  }

  if (pos !== body.length) return undefined;
  return matched ? matchedValue : false;
}
