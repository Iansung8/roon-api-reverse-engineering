import assert from 'node:assert/strict';
import test from 'node:test';
import { writeFlexInt } from '../../roon-internal-api/src/proto/flex';
import { decodeBoolProfileData } from './profile-data-bool';

const PROFILE = Buffer.from('010203', 'hex');
const OTHER = Buffer.from('aabb', 'hex');

function integer(value: number): Buffer {
  const bytes: number[] = [];
  writeFlexInt(bytes, value);
  return Buffer.from(bytes);
}

function body(entries: Array<[Buffer, boolean]>): Buffer {
  return Buffer.concat([
    integer(entries.length),
    ...entries.flatMap(([key, value]) => [integer(key.length), key, Buffer.from([value ? 1 : 0])]),
  ]);
}

test('valid profile data resolves matching values and the proven false default', () => {
  assert.equal(decodeBoolProfileData(Buffer.from([0]), PROFILE), false);
  assert.equal(decodeBoolProfileData(body([[OTHER, false], [PROFILE, true]]), PROFILE), true);
  assert.equal(decodeBoolProfileData(body([[OTHER, true], [PROFILE, false]]), PROFILE), false);
  assert.equal(decodeBoolProfileData(body([[OTHER, true]]), PROFILE), false);
});

test('duplicate profile keys preserve first-match lookup behavior', () => {
  assert.equal(decodeBoolProfileData(body([[PROFILE, false], [PROFILE, true]]), PROFILE), false);
  assert.equal(decodeBoolProfileData(body([[PROFILE, true], [PROFILE, false]]), PROFILE), true);
});

test('malformed profile data fails closed instead of inventing favorite state', () => {
  const invalid = [
    Buffer.alloc(0),                         // missing count
    Buffer.from([0x80]),                    // truncated count varint
    Buffer.from([0x80, 0]),                 // overlong count varint
    integer(-1),                            // negative count
    Buffer.from([1]),                       // count exceeds minimum remaining bytes
    Buffer.from([1, 0x80]),                 // truncated key-length varint
    Buffer.from([1, 0x80, 0, 0]),           // overlong key-length varint
    Buffer.concat([Buffer.from([1]), integer(-1)]),
    Buffer.from([1, 2, 0xaa]),              // key extends through required bool
    Buffer.from([1, 1, 0xaa]),              // missing bool
    Buffer.from([1, 1, 0xaa, 2]),           // noncanonical bool
    Buffer.from([0, 0]),                    // trailing data
    Buffer.from([0x90, 0x80, 0x80, 0x80, 0]), // 32-bit overflow
    Buffer.concat([                         // invalid later tuple after a match
      integer(2), integer(PROFILE.length), PROFILE, Buffer.from([1]),
      integer(OTHER.length), OTHER, Buffer.from([2]),
    ]),
  ];
  for (const value of invalid) assert.equal(decodeBoolProfileData(value, PROFILE), undefined, value.toString('hex'));
});
