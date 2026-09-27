import type { ICredentialType, INodeProperties } from "n8n-workflow";

export class PreyReachOAuth2Api implements ICredentialType {
  name = "preyreachOAuth2Api";
  displayName = "PreyReach OAuth2 API";
  documentationUrl =
    "https://github.com/preyreach/n8n-nodes-preyreach#authentication";
  icon = { light: "file:preyreach.svg", dark: "file:preyreach.svg" } as const;
  extends = ["oAuth2Api"];
  properties: INodeProperties[] = [
    {
      displayName: "Use Dynamic Client Registration",
      name: "useDynamicClientRegistration",
      type: "hidden",
      default: true,
    },
    {
      displayName: "Server URL",
      name: "serverUrl",
      type: "hidden",
      default: "https://mcp.preyreach.com/mcp",
    },
    {
      displayName: "Resource URL",
      name: "resourceUrl",
      type: "hidden",
      default: "https://mcp.preyreach.com/mcp",
    },
  ];
}
