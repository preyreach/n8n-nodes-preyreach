import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	IHttpRequestOptions,
} from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

interface Schema {
	default?: unknown;
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

export function parseArgument(
	value: unknown,
	schema: Schema,
	required: boolean,
	name: string,
): unknown {
	if ((value === undefined || value === null || value === '') && schema.default !== undefined)
		value = schema.default;
	const type = Array.isArray(schema.type) ? schema.type.find((t) => t !== 'null') : schema.type;
	if (value === null && Array.isArray(schema.type) && schema.type.includes('null')) return null;
	if (value === undefined || value === null || value === '') {
		if (required) throw new Error(`${name} is required`);
		return undefined;
	}
	if (type === 'object' || type === 'array') {
		if (typeof value === 'string') {
			let invalid = false;
			try {
				value = JSON.parse(value);
			} catch {
				invalid = true;
			}
			if (invalid) throw new Error(`${name} must be valid JSON`);
		}
		if (
			type === 'array'
				? !Array.isArray(value)
				: typeof value !== 'object' || Array.isArray(value) || value === null
		)
			throw new Error(`${name} has the wrong JSON type`);
	}
	if (type === 'integer' || type === 'number') {
		if (
			typeof value !== 'number' ||
			!Number.isFinite(value) ||
			(type === 'integer' && !Number.isInteger(value))
		)
			throw new Error(`${name} must be a valid ${type}`);
		if (schema.minimum !== undefined && value < schema.minimum)
			throw new Error(`${name} is below the minimum`);
		if (schema.maximum !== undefined && value > schema.maximum)
			throw new Error(`${name} is above the maximum`);
	}
	if (type === 'boolean' && typeof value !== 'boolean')
		throw new Error(`${name} must be a boolean`);
	if (type === 'string') {
		if (typeof value !== 'string') throw new Error(`${name} must be a string`);
		if (schema.minLength !== undefined && value.length < schema.minLength)
			throw new Error(`${name} is too short`);
		if (schema.maxLength !== undefined && value.length > schema.maxLength)
			throw new Error(`${name} is too long`);
	}
	if (schema.enum && !schema.enum.includes(value))
		throw new Error(`${name} must be one of the listed options`);
	return value;
}

export interface ResourceRoute {
	method: IHttpRequestOptions['method'];
	path: string;
}
export async function executeOperations(
	ctx: IExecuteFunctions,
	origin: string,
	credential: string,
	operations: Operation[],
	routes: Record<string, ResourceRoute>,
): Promise<INodeExecutionData[][]> {
	const output: INodeExecutionData[] = [];
	const items = ctx.getInputData();
	for (let i = 0; i < items.length; i++) {
		try {
			const name = ctx.getNodeParameter('operation', i) as string;
			const operation = operations.find((op) => op.name === name),
				route = routes[name];
			if (!operation || !route)
				throw new NodeOperationError(ctx.getNode(), 'Choose a supported operation');
			if (
				operation.annotations?.readOnlyHint !== true &&
				ctx.getNodeParameter('confirmWrite', i, false) !== true
			)
				throw new NodeOperationError(
					ctx.getNode(),
					'Enable the write-operation confirmation before running this action',
				);
			const args: Record<string, unknown> = {};
			const required = operation.inputSchema.required ?? [];
			const extra = ctx.getNodeParameter(`options_${name}`, i, {}) as Record<string, unknown>;
			for (const [key, schema] of Object.entries(operation.inputSchema.properties ?? {})) {
				const isRequired = required.includes(key);
				const value = parseArgument(
					isRequired ? ctx.getNodeParameter(`${name}__${key}`, i) : extra[key],
					schema,
					isRequired,
					key,
				);
				if (value !== undefined) args[key] = value;
			}
			const path = route.path.replace(/:([A-Za-z][A-Za-z0-9]*)/g, (_match, key: string) => {
				const value = args[key];
				if (
					typeof value !== 'string' ||
					!value ||
					value === '.' ||
					value === '..' ||
					/[\\/]/.test(value)
				)
					throw new NodeOperationError(ctx.getNode(), `${key} is required`);
				delete args[key];
				return encodeURIComponent(value);
			});
			const url = new URL(path, origin);
			if (url.origin !== origin || !url.pathname.startsWith('/v1/'))
				throw new NodeOperationError(ctx.getNode(), 'Invalid API resource');
			const options: IHttpRequestOptions = {
				method: route.method,
				url: url.href,
				json: true,
				returnFullResponse: true,
				disableFollowRedirect: true,
				timeout: 120000,
				headers: { Accept: 'application/json' },
			};
			if (route.method === 'GET') {
				for (const [key, value] of Object.entries(args))
					url.searchParams.set(
						key,
						typeof value === 'object' ? JSON.stringify(value) : String(value),
					);
				options.url = url.href;
			} else if (Object.keys(args).length || route.method !== 'DELETE') {
				options.body = args;
				options.headers = { ...options.headers, 'Content-Type': 'application/json' };
			}
			let response;
			try {
				response = await ctx.helpers.httpRequestWithAuthentication.call(ctx, credential, options);
			} catch (error) {
				const status = (error as { statusCode?: number }).statusCode;
				throw new NodeOperationError(
					ctx.getNode(),
					typeof status === 'number'
						? `API request failed (HTTP ${status}). Reconnect for 401/403; check plan limits for 429.`
						: 'The API request failed. Check the connection and permissions.',
				);
			}
			const status = Number(response.statusCode ?? 200);
			if (status < 200 || status >= 300)
				throw new NodeOperationError(
					ctx.getNode(),
					`API request failed (HTTP ${status}). Check permissions and inputs.`,
				);
			let body: unknown = response.body;
			if (status === 204 || body === undefined || body === '') body = { success: true };
			if (typeof body === 'string') {
				try {
					body = JSON.parse(body);
				} catch {
					throw new NodeOperationError(ctx.getNode(), 'The API returned an invalid JSON response');
				}
			}
			const json =
				body && typeof body === 'object' && !Array.isArray(body)
					? (body as IDataObject)
					: ({ data: body } as IDataObject);
			output.push({ json, pairedItem: { item: i } });
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Operation failed';
			if (ctx.continueOnFail()) {
				output.push({ json: { error: message }, pairedItem: { item: i } });
				continue;
			}
			throw new NodeOperationError(ctx.getNode(), message, { itemIndex: i });
		}
	}
	return [output];
}
