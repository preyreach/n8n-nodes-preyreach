const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const pkg = require('../package.json');
const file = '../' + pkg.n8n.nodes[0];
const Node = Object.values(require(file))[0],
	node = new Node();
const folder = path.dirname(require.resolve(file));
const operations = require(path.join(folder, 'operations.json')),
	routes = require(path.join(folder, 'routes.json'));
const { parseArgument, requestPages } = require(path.join(folder, 'transport.js'));
function sample(schema) {
	const type = Array.isArray(schema.type) ? schema.type.find((t) => t !== 'null') : schema.type;
	if (schema.enum) return schema.enum[0];
	if (type === 'integer' || type === 'number') return schema.minimum ?? 1;
	if (type === 'boolean') return true;
	if (type === 'array')
		return Array.from({ length: schema.minItems ?? 1 }, () =>
			sample(schema.items ?? { type: 'string' }),
		);
	if (type === 'object')
		return Object.fromEntries(
			(schema.required ?? []).map((key) => [key, sample(schema.properties[key])]),
		);
	return 'fixture-123';
}
function context(
	op = operations[0],
	{
		items = [{ json: {} }],
		response = { statusCode: 200, body: { ok: true } },
		error,
		params = {},
		continueOnFail = false,
		confirm = true,
	} = {},
) {
	const calls = [];
	const values = { operation: op.name, confirmWrite: confirm };
	for (const key of op.inputSchema.required ?? [])
		values[op.name + '__' + key] = sample(op.inputSchema.properties[key]);
	Object.assign(values, params);
	const ctx = {
		getInputData: () => items,
		getNode: () => ({
			name: 'Test',
			type: 'test',
			typeVersion: 1,
			parameters: {},
			position: [0, 0],
		}),
		getNodeParameter: (name, i, fallback) => values[name] ?? fallback,
		continueOnFail: () => continueOnFail,
		helpers: {
			httpRequestWithAuthentication: async (credential, options) => {
				calls.push({ credential, options });
				if (error) throw error;
				return response;
			},
		},
	};
	return { ctx, calls };
}
test('each operation makes one native REST request with no MCP handshake, headers or envelope', async () => {
	for (const op of operations) {
		const paging = routes[op.name].pagination;
		const expected = { ok: true };
		if (paging) {
			let target = expected;
			const keys = paging.items[0].split('.');
			for (const key of keys.slice(0, -1)) target = target[key] = {};
			target[keys.at(-1)] = [];
			if (paging.kind === 'page') expected.pagination = { page: 1, pages: 1, total: 0, limit: 0 };
		}
		const { ctx, calls } = context(op, { response: { statusCode: 200, body: expected } });
		const result = await node.execute.call(ctx);
		assert.equal(calls.length, 1, op.name);
		const { credential, options } = calls[0];
		assert.equal(credential, node.description.credentials[0].name);
		assert.equal(options.method, routes[op.name].method);
		const url = new URL(options.url);
		assert.equal(url.protocol, 'https:');
		assert(url.pathname.startsWith('/v1/'));
		assert(options.disableFollowRedirect);
		assert.equal(options.headers.Accept, 'application/json');
		assert(!JSON.stringify(options).includes('jsonrpc'));
		assert(!JSON.stringify(options.headers).includes('MCP'));
		assert.deepEqual(result[0][0].json, expected);
	}
});
test('links outputs to the corresponding input item', async () => {
	const { ctx, calls } = context(
		operations.find((o) => !routes[o.name].pagination),
		{
			items: [{ json: { a: 1 } }, { json: { a: 2 } }],
		},
	);
	const result = await node.execute.call(ctx);
	assert.equal(calls.length, 2);
	assert.deepEqual(
		result[0].map((x) => x.pairedItem),
		[{ item: 0 }, { item: 1 }],
	);
});
test('encodes identifiers without exposing them as path or query structure', async () => {
	const op = operations.find((o) => routes[o.name].path.includes(':'));
	if (!op) return;
	const key = routes[op.name].path.match(/:([A-Za-z][A-Za-z0-9]*)/)[1];
	const { ctx, calls } = context(op, { params: { [op.name + '__' + key]: 'owned?item#one' } });
	await node.execute.call(ctx);
	assert(calls[0].options.url.includes('owned%3Fitem%23one'));
	assert.equal(new URL(calls[0].options.url).hash, '');
	assert(!calls[0].options.body?.[key]);
});
test('selected write operations execute without a confirmation checkbox', async () => {
	const op = operations.find((o) => o.annotations?.readOnlyHint !== true);
	if (!op) return;
	const { ctx, calls } = context(op, { confirm: false });
	await node.execute.call(ctx);
	assert.equal(calls.length, 1);
	assert(!node.description.properties.some((p) => p.name === 'confirmWrite'));
});
test('invalid required values fail before a network request', async () => {
	const op = operations.find((o) => (o.inputSchema.required ?? []).length);
	if (!op) return;
	const key = op.inputSchema.required[0];
	const { ctx, calls } = context(op, { params: { [op.name + '__' + key]: '' } });
	await assert.rejects(node.execute.call(ctx), /required/);
	assert.equal(calls.length, 0);
});
test('HTTP failures never copy secrets or raw provider errors into workflow data', async () => {
	const error = Object.assign(new Error('Bearer SECRET; private response'), {
		statusCode: 401,
		request: { headers: { Authorization: 'Bearer SECRET' } },
	});
	const { ctx } = context(
		operations.find((o) => !routes[o.name].pagination),
		{ error, continueOnFail: true },
	);
	const result = await node.execute.call(ctx);
	assert.match(result[0][0].json.error, /401/);
	assert(!JSON.stringify(result).includes('SECRET'));
});
test('204 responses become a successful JSON item', async () => {
	const { ctx } = context(
		operations.find((o) => !routes[o.name].pagination),
		{ response: { statusCode: 204, body: '' } },
	);
	assert.deepEqual((await node.execute.call(ctx))[0][0].json, { success: true });
});
test('rejects invalid JSON responses', async () => {
	const { ctx } = context(
		operations.find((o) => !routes[o.name].pagination),
		{
			response: { statusCode: 200, body: '<html>error</html>' },
		},
	);
	await assert.rejects(node.execute.call(ctx), /invalid JSON/);
});
test('parses valid JSON arrays and rejects wrong types and out-of-range values', () => {
	assert.deepEqual(parseArgument('["a"]', { type: 'array' }, true, 'values'), ['a']);
	assert.throws(() => parseArgument('{}', { type: 'array' }, true, 'values'));
	assert.throws(() => parseArgument(4, { type: 'integer', maximum: 3 }, true, 'count'));
});

test('all operations are organised under resource selectors', () => {
	const properties = node.description.properties;
	const resource = properties.find((p) => p.name === 'resource');
	assert(resource);
	const selectors = properties.filter((p) => p.name === 'operation');
	const seen = [];
	for (const selector of selectors) {
		assert.equal(selector.displayOptions.show.resource.length, 1);
		assert(resource.options.some((r) => r.value === selector.displayOptions.show.resource[0]));
		seen.push(...selector.options.map((o) => o.value));
	}
	assert.deepEqual(seen.sort(), operations.map((o) => o.name).sort());
});

test('n8n resolves each resource to its own operation and visible required fields', () => {
	const { NodeHelpers } = require('n8n-workflow');
	const properties = node.description.properties;
	const resource = properties.find((parameter) => parameter.name === 'resource');
	for (const option of resource.options) {
		const selector = properties.find(
			(parameter) =>
				parameter.name === 'operation' &&
				parameter.displayOptions.show.resource.includes(option.value),
		);
		const defaults = NodeHelpers.getNodeParameters(
			properties,
			{ resource: option.value },
			true,
			false,
			{ typeVersion: 1 },
			node.description,
		);
		assert.equal(defaults.operation, selector.default);
		for (const operation of selector.options) {
			const parameters = NodeHelpers.getNodeParameters(
				properties,
				{ resource: option.value, operation: operation.value },
				true,
				false,
				{ typeVersion: 1 },
				node.description,
			);
			assert.equal(parameters.operation, operation.value);
			const schema = operations.find((entry) => entry.name === operation.value).inputSchema;
			for (const field of schema.required ?? []) {
				assert(
					Object.hasOwn(parameters, `${operation.value}__${field}`),
					`${operation.value}: ${field} must be visible`,
				);
			}
			for (const other of operations.filter((entry) => entry.name !== operation.value)) {
				for (const field of other.inputSchema.required ?? []) {
					assert(
						!Object.hasOwn(parameters, `${other.name}__${field}`),
						`${other.name}: ${field} must be hidden`,
					);
				}
			}
		}
	}
});

function pagingContext(pages) {
	const calls = [];
	const ctx = {
		getNode: () => ({
			name: 'Test',
			type: 'test',
			parameters: {},
			typeVersion: 1,
			position: [0, 0],
		}),
		helpers: {
			httpRequestWithAuthentication: async (c, o) => {
				calls.push(o);
				const body = pages[calls.length - 1];
				if (body instanceof Error) throw body;
				if (body === undefined) throw new Error('Unexpected extra request');
				return { statusCode: 200, body: structuredClone(body) };
			},
		},
	};
	return { ctx, calls };
}
const baseOptions = {
	method: 'GET',
	url: 'https://example.com/v1/resources?filter=owned',
	json: true,
	disableFollowRedirect: true,
};
test('collects multiple offset pages, truncates exactly at Limit, preserves envelope', async () => {
	const { ctx, calls } = pagingContext([
		{ reports: [1, 2], nextOffset: 2, url: 'product' },
		{ reports: [3, 4], nextOffset: 4 },
	]);
	const result = await requestPages(
		ctx,
		'test',
		baseOptions,
		{ method: 'GET', path: '/v1/resources', pagination: { kind: 'offset', items: ['reports'] } },
		false,
		3,
	);
	assert.deepEqual(result, { reports: [1, 2, 3], url: 'product' });
	assert.deepEqual(
		calls.map((c) => new URL(c.url).searchParams.get('offset')),
		['0', '2'],
	);
	assert(
		calls.every(
			(c) => new URL(c.url).searchParams.get('filter') === 'owned' && c.disableFollowRedirect,
		),
	);
});
test('Return All follows cursors including empty intermediate pages and preserves filters', async () => {
	for (const token of ['nextPageToken', 'nextCursor']) {
		const { ctx, calls } = pagingContext([
			{ data: { results: [1], [token]: 'first' } },
			{ data: { results: [], [token]: 'second' } },
			{ data: { results: [2] } },
		]);
		const result = await requestPages(
			ctx,
			'test',
			baseOptions,
			{
				method: 'GET',
				path: '/v1/resources',
				pagination: { kind: 'cursor', items: ['data.results', 'data.data'] },
			},
			true,
			1,
		);
		assert.deepEqual(result, { data: { results: [1, 2] } });
		assert.deepEqual(
			calls.map((c) => new URL(c.url).searchParams.get('cursor')),
			[null, 'first', 'second'],
		);
	}
});
test('handles Meta nested data arrays and stops at terminal token', async () => {
	const { ctx, calls } = pagingContext([
		{ provider: 'meta', data: { data: [1], nextCursor: 'a' } },
		{ data: { data: [2] } },
	]);
	const result = await requestPages(
		ctx,
		'test',
		baseOptions,
		{
			method: 'GET',
			path: '/v1/resources',
			pagination: { kind: 'cursor', items: ['data.results', 'data.data'] },
		},
		true,
		50,
	);
	assert.deepEqual(result, { provider: 'meta', data: { data: [1, 2] } });
	assert.equal(calls.length, 2);
});
test('page-based lists follow the documented last page', async () => {
	const { ctx, calls } = pagingContext([
		{ items: [1], pagination: { page: 1, pages: 2 } },
		{ items: [2], pagination: { page: 2, pages: 2 } },
	]);
	const result = await requestPages(
		ctx,
		'test',
		baseOptions,
		{ method: 'GET', path: '/v1/resources', pagination: { kind: 'page', items: ['items'] } },
		true,
		50,
	);
	assert.deepEqual(result.items, [1, 2]);
	assert.deepEqual(
		calls.map((c) => new URL(c.url).searchParams.get('page')),
		['1', '2'],
	);
});
test('complete-set APIs are fetched once and limited locally', async () => {
	const { ctx, calls } = pagingContext([{ members: [1, 2, 3], currentMemberEmail: 'sample' }]);
	const result = await requestPages(
		ctx,
		'test',
		baseOptions,
		{ method: 'GET', path: '/v1/resources', pagination: { kind: 'complete', items: ['members'] } },
		false,
		2,
	);
	assert.deepEqual(result, { members: [1, 2], currentMemberEmail: 'sample' });
	assert.equal(calls.length, 1);
});
test('repeated cursors and failed later pages reject instead of returning incomplete success', async () => {
	const route = {
		method: 'GET',
		path: '/v1/resources',
		pagination: { kind: 'cursor', items: ['data.results'] },
	};
	let c = pagingContext([
		{ data: { results: [1], nextCursor: 'x' } },
		{ data: { results: [2], nextCursor: 'x' } },
	]);
	await assert.rejects(requestPages(c.ctx, 'test', baseOptions, route, true, 50), /repeated/);
	c = pagingContext([
		{ data: { results: [1], nextCursor: 'x' } },
		Object.assign(new Error('SECRET'), { statusCode: 429 }),
	]);
	await assert.rejects(
		requestPages(c.ctx, 'test', baseOptions, route, true, 50),
		(e) => e.message.includes('429') && !e.message.includes('SECRET'),
	);
});
test('empty lists stop and malformed lists fail explicitly', async () => {
	const route = {
		method: 'GET',
		path: '/v1/resources',
		pagination: { kind: 'offset', items: ['reports'] },
	};
	let c = pagingContext([{ reports: [], nextOffset: null }]);
	assert.deepEqual(await requestPages(c.ctx, 'test', baseOptions, route, true, 50), {
		reports: [],
	});
	assert.equal(c.calls.length, 1);
	c = pagingContext([{ unexpected: [] }]);
	await assert.rejects(requestPages(c.ctx, 'test', baseOptions, route, true, 50), /invalid list/);
});
test('list controls are resolved by n8n without exposed transport tokens', () => {
	const { NodeHelpers } = require('n8n-workflow');
	const props = node.description.properties;
	for (const [op, route] of Object.entries(routes)) {
		if (!route.pagination) continue;
		const selector = props.find(
			(p) => p.name === 'operation' && p.options.some((o) => o.value === op),
		);
		const input = {
			resource: selector.displayOptions.show.resource[0],
			operation: op,
			returnAll: true,
		};
		const all = NodeHelpers.getNodeParameters(
			props,
			input,
			true,
			false,
			{ typeVersion: 1 },
			node.description,
		);
		assert.equal(all.returnAll, true);
		assert(!Object.hasOwn(all, 'limit'));
		const limited = NodeHelpers.getNodeParameters(
			props,
			{ ...input, returnAll: false },
			true,
			false,
			{ typeVersion: 1 },
			node.description,
		);
		assert.equal(limited.limit, 50);
		const optional = props.find((p) => p.name === 'options_' + op);
		assert(!optional?.options.some((p) => ['offset', 'cursor', 'page'].includes(p.name)));
	}
});
