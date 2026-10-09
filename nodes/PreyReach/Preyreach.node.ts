import type {
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeConnectionTypes } from 'n8n-workflow';
import { executeOperations, type Operation, type ResourceRoute } from './transport';
import operations from './operations.json';
import routes from './routes.json';

export class Preyreach implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'PreyReach',
		name: 'preyreach',
		icon: { light: 'file:preyreach.svg', dark: 'file:preyreach.svg' },
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["resource"] + ": " + $parameter["operation"]}}',
		description: 'Automate your PreyReach account',
		defaults: { name: 'PreyReach' },
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		usableAsTool: true,
		credentials: [{ name: 'preyreachApi', required: true }],
		properties: [
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				options: [
					{
						name: 'Account',
						value: 'account',
					},
					{
						name: 'Search',
						value: 'searches',
					},
				],
				default: 'account',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				default: 'account',
				options: [
					{
						name: 'Account',
						value: 'account',
						description:
							'Read the API key name and current search allowance. No account secrets are returned.',
						action: 'Account',
					},
				],
				displayOptions: {
					show: {
						resource: ['account'],
					},
				},
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				default: 'get_search',
				options: [
					{
						name: 'Get Preyreach Search',
						value: 'get_search',
						description: 'Read the status and results of a search owned by this API key',
						action: 'Get preyreach search',
					},
					{
						name: 'Search Preyreach Leads',
						value: 'search_leads',
						description:
							'Submit a native REST search. Returns an ID and pollUrl; use Get Search until completed. This consumes the API key search allowance.',
						action: 'Search preyreach leads',
					},
					{
						name: 'Enrich Search',
						value: 'enrich_search',
						description: 'Enrich a completed search result without charging those leads again',
						action: 'Enrich search',
					},
				],
				displayOptions: {
					show: {
						resource: ['searches'],
					},
				},
			},
			{
				displayName: 'Search ID',
				name: 'get_search__searchId',
				type: 'string',
				required: true,
				default: '',
				displayOptions: {
					show: {
						operation: ['get_search'],
						resource: ['searches'],
					},
				},
				description: 'The searchId returned by search_leads',
			},
			{
				displayName: 'Prompt',
				name: 'search_leads__prompt',
				type: 'string',
				required: true,
				default: '',
				displayOptions: {
					show: {
						operation: ['search_leads'],
						resource: ['searches'],
					},
				},
				description: 'Example: find dentists in Austin with website and phone',
			},
			{
				displayName: 'Search ID',
				name: 'enrich_search__searchId',
				type: 'string',
				required: true,
				default: '',
				displayOptions: {
					show: {
						operation: ['enrich_search'],
						resource: ['searches'],
					},
				},
				description: 'Search identifier returned by Submit Search',
			},
			{
				displayName: 'Confirm Write Operation',
				name: 'confirmWrite',
				type: 'boolean',
				default: false,
				displayOptions: {
					show: {
						operation: ['search_leads', 'enrich_search'],
						resource: ['searches'],
					},
				},
				description:
					'Whether to allow this operation to create or update data and use the API key search allowance',
			},
		],
	};
	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		return executeOperations(
			this,
			'https://api.preyreach.com',
			'preyreachApi',
			operations as unknown as Operation[],
			routes as Record<string, ResourceRoute>,
		);
	}
}
