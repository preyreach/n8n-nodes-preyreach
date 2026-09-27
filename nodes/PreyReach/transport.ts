import type {
  IDataObject,
  IExecuteFunctions,
  INodeExecutionData,
  IHttpRequestOptions,
} from "n8n-workflow";
import { NodeOperationError } from "n8n-workflow";

interface Schema {
  type?: string | string[];
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
}
export interface Operation {
  name: string;
  inputSchema: { properties?: Record<string, Schema>; required?: string[] };
  annotations?: { readOnlyHint?: boolean };
}

export function decodeRpc(body: unknown, id: number): Record<string, unknown> {
  let value: unknown = body;
  if (typeof body === "string") {
    try {
      value = JSON.parse(body);
    } catch {
      const events = body.split(/\r?\n\r?\n/);
      value = undefined;
      for (const event of events) {
        const data = event
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (!data) continue;
        try {
          const message = JSON.parse(data);
          if (message.id === id) {
            value = message;
            break;
          }
        } catch {
          /* Non-JSON keepalive. */
        }
      }
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("The service returned an invalid MCP response");
  const rpc = value as Record<string, unknown>;
  if (rpc.id !== id)
    throw new Error("The service returned a mismatched response ID");
  if (rpc.error)
    throw new Error(
      "The service rejected the request. Check the operation, permissions, and inputs.",
    );
  if (!rpc.result || typeof rpc.result !== "object")
    throw new Error("The service response is missing its result");
  return rpc.result as Record<string, unknown>;
}

export function parseArgument(
  value: unknown,
  schema: Schema,
  required: boolean,
  name: string,
): unknown {
  const type = Array.isArray(schema.type)
    ? schema.type.find((t) => t !== "null")
    : schema.type;
  if (
    value === null &&
    Array.isArray(schema.type) &&
    schema.type.includes("null")
  )
    return null;
  if (value === undefined || value === null || value === "") {
    if (required) throw new Error(`${name} is required`);
    return undefined;
  }
  if (type === "object" || type === "array") {
    if (typeof value === "string") {
      let invalid = false;
      try {
        value = JSON.parse(value);
      } catch {
        invalid = true;
      }
      if (invalid) throw new Error(`${name} must be valid JSON`);
    }
    if (
      type === "array"
        ? !Array.isArray(value)
        : typeof value !== "object" || Array.isArray(value) || value === null
    )
      throw new Error(`${name} has the wrong JSON type`);
  }
  if (type === "integer" || type === "number") {
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      (type === "integer" && !Number.isInteger(value))
    )
      throw new Error(`${name} must be a valid ${type}`);
    if (schema.minimum !== undefined && value < schema.minimum)
      throw new Error(`${name} is below the minimum`);
    if (schema.maximum !== undefined && value > schema.maximum)
      throw new Error(`${name} is above the maximum`);
  }
  if (type === "boolean" && typeof value !== "boolean")
    throw new Error(`${name} must be a boolean`);
  if (type === "string") {
    if (typeof value !== "string") throw new Error(`${name} must be a string`);
    if (schema.minLength !== undefined && value.length < schema.minLength)
      throw new Error(`${name} is too short`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength)
      throw new Error(`${name} is too long`);
  }
  if (schema.enum && !schema.enum.includes(value))
    throw new Error(`${name} must be one of the listed options`);
  return value;
}

export async function executeOperations(
  ctx: IExecuteFunctions,
  endpoint: string,
  credential: string,
  operations: Operation[],
): Promise<INodeExecutionData[][]> {
  const items = ctx.getInputData();
  const output: INodeExecutionData[] = [];
  let session: string | undefined;
  let protocol = "2025-03-26";
  let initialized = false;
  const request = async (
    body: object,
    id?: number,
  ): Promise<Record<string, unknown>> => {
    const options: IHttpRequestOptions = {
      method: "POST",
      url: endpoint,
      body,
      json: true,
      returnFullResponse: true,
      disableFollowRedirect: true,
      timeout: 120000,
      headers: {
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
        "MCP-Protocol-Version": protocol,
        ...(session ? { "Mcp-Session-Id": session } : {}),
      },
    };
    let response;
    try {
      response = await ctx.helpers.httpRequestWithAuthentication.call(
        ctx,
        credential,
        options,
      );
    } catch (error) {
      const status = (error as { statusCode?: number }).statusCode;
      throw new NodeOperationError(
        ctx.getNode(),
        typeof status === "number"
          ? `Request failed (HTTP ${status}). Reconnect for 401/403; check plan limits for 429.`
          : "The service request failed. Check the connection and reconnect OAuth if needed.",
      );
    }
    const header = response.headers?.["mcp-session-id"];
    if (typeof header === "string") session = header;
    return id === undefined ? {} : decodeRpc(response.body, id);
  };
  for (let i = 0; i < items.length; i++) {
    try {
      const name = ctx.getNodeParameter("operation", i) as string;
      const operation = operations.find((op) => op.name === name);
      if (!operation) throw new Error("Choose a supported operation");
      if (
        operation.annotations?.readOnlyHint !== true &&
        ctx.getNodeParameter("confirmWrite", i, false) !== true
      )
        throw new Error(
          "Enable the write-operation confirmation before running this action",
        );
      const args: Record<string, unknown> = {};
      const required = operation.inputSchema.required ?? [];
      const extra = ctx.getNodeParameter(`options_${name}`, i, {}) as Record<
        string,
        unknown
      >;
      for (const [key, schema] of Object.entries(
        operation.inputSchema.properties ?? {},
      )) {
        const isRequired = required.includes(key);
        const raw = isRequired
          ? ctx.getNodeParameter(`${name}__${key}`, i)
          : extra[key];
        const value = parseArgument(raw, schema, isRequired, key);
        if (value !== undefined) args[key] = value;
      }
      if (!initialized) {
        const result = await request(
          {
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
              protocolVersion: protocol,
              capabilities: {},
              clientInfo: { name: credential, version: "1.0.0" },
            },
          },
          1,
        );
        if (typeof result.protocolVersion === "string")
          protocol = result.protocolVersion;
        await request({ jsonrpc: "2.0", method: "notifications/initialized" });
        initialized = true;
      }
      const result = await request(
        {
          jsonrpc: "2.0",
          id: i + 2,
          method: "tools/call",
          params: { name, arguments: args },
        },
        i + 2,
      );
      if (result.isError)
        throw new Error(
          "The operation failed. Check the item, account permissions, plan limits, and supplied fields in the product.",
        );
      let data: unknown = result.structuredContent;
      if (data === undefined) {
        const content = result.content as
          | Array<{ type?: string; text?: string }>
          | undefined;
        const text =
          content
            ?.filter((c) => c.type === "text")
            .map((c) => c.text ?? "")
            .join("\n") ?? "";
        try {
          data = JSON.parse(text);
        } catch {
          data = { text };
        }
      }
      const json =
        data && typeof data === "object" && !Array.isArray(data)
          ? (data as IDataObject)
          : ({ data } as IDataObject);
      output.push({ json, pairedItem: { item: i } });
    } catch (error) {
      // Never copy request headers, OAuth tokens, or raw HTTP error objects into workflow output.
      const status = (error as { statusCode?: number }).statusCode;
      const message = status
        ? `Request failed (HTTP ${status}). Reconnect for 401/403; check plan limits for 429.`
        : error instanceof Error
          ? error.message
          : "Operation failed";
      if (ctx.continueOnFail()) {
        output.push({ json: { error: message }, pairedItem: { item: i } });
        continue;
      }
      throw new NodeOperationError(ctx.getNode(), message, { itemIndex: i });
    }
  }
  return [output];
}
