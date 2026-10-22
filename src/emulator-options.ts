export function graphicsArguments(gpu = 'auto', noVulkan = false) {
  if (!['auto', 'swiftshader', 'host'].includes(gpu)) throw new Error('Режим GPU: auto, swiftshader или host');
  return ['-gpu', gpu, ...(noVulkan ? ['-feature', '-Vulkan'] : [])];
}
