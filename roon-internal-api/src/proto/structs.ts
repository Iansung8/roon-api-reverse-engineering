/** Shared sparse-value builder for handwritten and generated APIs. */
import { structSchema } from '../generated/struct-schemas';
import { RemotingClient } from './remoting';
import { inlineStruct, serializeStructValue } from './serializer';

interface Field { name: string; propType: number; value: Buffer }

export function structArg(remoting: RemotingClient, typeName: string, fields: readonly Field[]): Buffer {
  // Unknown types may declare a single immutable schema. defineType rejects
  // subsequent incompatible reuse rather than silently corrupting field indexes.
  const members = structSchema(typeName) ?? fields;
  const used = new Set<number>();
  const entries = fields.map((field) => {
    const index = members.findIndex((m) => m.name === field.name || ('shortName' in m && m.shortName === field.name));
    if (index < 0) throw new Error(`unknown member ${field.name} for ${typeName}`);
    if (members[index].propType !== field.propType) throw new Error(`property type mismatch for ${typeName}::${field.name}`);
    if (used.has(index)) throw new Error(`duplicate member ${field.name} for ${typeName}`);
    used.add(index);
    return { index: index + 1, value: field.value };
  });
  return inlineStruct(remoting.defineType(typeName, members), entries);
}

/** Generated callers provide JS values and ergonomic short or full field names. */
export function buildStruct(c: { remoting: RemotingClient }, typeName: string, fields: Record<string, unknown>): Buffer {
  const members = structSchema(typeName);
  if (!members) throw new Error(`no canonical schema for ${typeName}; use structArg with explicit wire members`);
  return structArg(c.remoting, typeName, Object.entries(fields).map(([name, value]) => {
    const member = members.find((m) => m.shortName === name || m.name === name);
    if (!member) throw new Error(`unknown member ${name} for ${typeName}`);
    if (member.propType === 24 && !Buffer.isBuffer(value)) {
      throw new Error(`${typeName}::${name} requires a pre-serialized length-prefixed Buffer`);
    }
    return { name, propType: member.propType, value: serializeStructValue(member.propType, value) };
  }));
}
