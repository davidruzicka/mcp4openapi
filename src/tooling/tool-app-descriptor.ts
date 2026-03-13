import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { LoadedProfileAppsModel } from '../profile/profile-apps.js';
import type { ToolDefinition } from '../types/profile.js';

export function composeToolDescriptor(
  baseTool: Tool,
  toolDef: ToolDefinition,
  appsModel?: LoadedProfileAppsModel,
): Tool {
  if (!toolDef.apps || !appsModel) {
    return baseTool;
  }

  const binding = appsModel.toolAppsByName.get(toolDef.name);
  if (!binding) {
    return baseTool;
  }

  return {
    ...baseTool,
    annotations: binding.annotations ? { ...(baseTool.annotations || {}), ...binding.annotations } : baseTool.annotations,
    _meta: {
      ...(baseTool._meta || {}),
      ...binding.meta,
    },
  };
}
