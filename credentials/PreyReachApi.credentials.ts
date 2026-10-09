import type {
	ICredentialType,
	INodeProperties,
	IAuthenticateGeneric,
	ICredentialTestRequest,
} from 'n8n-workflow';
export class PreyReachApi implements ICredentialType {
	name = 'preyreachApi';
	displayName = 'PreyReach API';
	documentationUrl = 'https://github.com/preyreach/n8n-nodes-preyreach#authentication';
	icon = { light: 'file:preyreach.svg', dark: 'file:preyreach.svg' } as const;
	properties: INodeProperties[] = [
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			required: true,
			default: '',
		},
	];
	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: { headers: { Authorization: '=Bearer {{$credentials.apiKey}}' } },
	};
	test: ICredentialTestRequest = {
		request: { baseURL: 'https://api.preyreach.com', url: '/v1/account', method: 'GET' },
	};
}
