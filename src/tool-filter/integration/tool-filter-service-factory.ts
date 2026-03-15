import type { Logger } from '../../core/logger.js';
import type { OpenAPIParser } from '../../openapi/openapi-parser.js';
import { EnvConfigParser } from '../config/env-config-parser.js';
import { HeaderConfigParser } from '../config/header-config-parser.js';
import { ToolFilterService } from './tool-filter-service.js';
import { OperationClassifier } from '../operation/operation-classifier.js';
import { OperationDetector } from '../operation/operation-detector.js';
import { OpenAPIOperationResolver } from '../operation/operation-resolver.js';
import { RegexCompiler } from '../regex/regex-compiler.js';
import { RegexValidator } from '../regex/regex-validator.js';

export interface CreateToolFilterServiceOptions {
  logger: Logger;
  parser?: OpenAPIParser;
}

export function createToolFilterService({
  logger,
  parser,
}: CreateToolFilterServiceOptions): ToolFilterService {
  const validator = new RegexValidator();
  const compiler = new RegexCompiler(validator);
  const envParser = new EnvConfigParser(compiler);
  const headerParser = new HeaderConfigParser(compiler);
  const detector = parser ? createOperationDetector(parser) : undefined;

  return new ToolFilterService(envParser, headerParser, logger, detector);
}

function createOperationDetector(parser: OpenAPIParser): OperationDetector {
  const classifier = new OperationClassifier();
  const resolver = new OpenAPIOperationResolver(parser);
  return new OperationDetector(classifier, resolver);
}
