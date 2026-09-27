import type {
  IExecuteFunctions,
  INodeExecutionData,
  INodeType,
  INodeTypeDescription,
  INodeProperties,
} from "n8n-workflow";
import { NodeConnectionTypes } from "n8n-workflow";
import { executeOperations, type Operation } from "./transport";
import operations from "./operations.json";
import properties from "./properties.json";

export class Preyreach implements INodeType {
  description: INodeTypeDescription = {
    displayName: "PreyReach",
    name: "preyreach",
    icon: { light: "file:preyreach.svg", dark: "file:preyreach.svg" },
    group: ["transform"],
    version: 1,
    subtitle: '={{$parameter["operation"]}}',
    description: "Automate your PreyReach account",
    defaults: { name: "PreyReach" },
    inputs: [NodeConnectionTypes.Main],
    outputs: [NodeConnectionTypes.Main],
    usableAsTool: true,
    credentials: [{ name: "preyreachOAuth2Api", required: true }],
    properties: properties as INodeProperties[],
  };
  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    return executeOperations(
      this,
      "https://mcp.preyreach.com/mcp",
      "preyreachOAuth2Api",
      operations as unknown as Operation[],
    );
  }
}
