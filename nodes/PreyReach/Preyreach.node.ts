import type {
  IExecuteFunctions,
  INodeExecutionData,
  INodeType,
  INodeTypeDescription,
  INodeProperties,
} from "n8n-workflow";
import { NodeConnectionTypes } from "n8n-workflow";
import { executeOperations, type Operation, type ResourceRoute } from "./transport";
import operations from "./operations.json";
import properties from "./properties.json";
import routes from "./routes.json";

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
    credentials: [{ name: "preyreachApi", required: true }],
    properties: properties as INodeProperties[],
  };
  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    return executeOperations(
      this,
      "https://api.preyreach.com",
      "preyreachApi",
      operations as unknown as Operation[],
      routes as Record<string,ResourceRoute>,
    );
  }
}
