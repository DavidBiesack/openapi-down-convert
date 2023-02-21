import * as v8 from 'v8';
import * as yaml from 'js-yaml';
import * as fs from 'fs';

/** OpenAPI Down Converted - convert an OAS document from OAS 3.1 to OAS 3.0 */

import {
  walkObject,
  visitSchemaObjects,
  visitRefObjects,
  SchemaVisitor,
  JsonNode,
  RefObject,
  SchemaObject,
} from './RefVisitor';

/** Lightweight OAS document top-level fields */
interface OpenAPI3 {
  openapi: string;
  info: object;
  paths: object;
  components: object;
  tags: object;
}

/** Options for the converter instantiation */
export interface ConverterOptions {
  /** if `true`, log conversion transformations to stderr  */
  verbose?: boolean;
  /** if `true`, remove `id` values in schema examples, to bypass
   * [Spectral issue 2081](https://github.com/stoplightio/spectral/issues/2081)
   */
  deleteExampleWithId?: boolean;
  /** If `true`, replace a `$ref` object that has siblings into an `allOf` */
  allOfTransform?: boolean;

  /**
   * The authorizationUrl for openIdConnect -> oauth2 transformation
   */
  authorizationUrl?: string;
  /** The tokenUrl for openIdConnect -> oauth2 transformation */
  tokenUrl?: string;
  /** Name of YAML/JSON file with scope descriptions.
   * This is a simple map in the format
   * `{ scope1: "description of scope1", ... }`
   */
  scopeDescriptionFile?: string;
}

export class Converter {
  private openapi30: OpenAPI3;
  private verbose = false;
  private deleteExampleWithId = false;
  private allOfTransform = false;
  private authorizationUrl: string;
  /** The tokenUrl for openIdConnect -> oauth2 transformation */
  private tokenUrl: string;
  private scopeDescriptions = {};

  constructor(openapiDocument: object, options?: ConverterOptions) {
    this.openapi30 = Converter.deepClone(openapiDocument) as OpenAPI3;
    this.verbose = Boolean(options?.verbose);
    this.deleteExampleWithId = Boolean(options?.deleteExampleWithId);
    this.allOfTransform = Boolean(options?.allOfTransform);
    this.authorizationUrl = options?.authorizationUrl || 'https://www.example.com/oauth2/authorize';
    this.tokenUrl = options?.tokenUrl || 'https://www.example.com/oauth2/token';
    this.loadScopeDescriptions(options?.scopeDescriptionFile);
  }

  loadScopeDescriptions(scopeDescriptionFile?: string) {
    if (!scopeDescriptionFile) {
      return;
    }
    this.scopeDescriptions = yaml.load(fs.readFileSync(scopeDescriptionFile, 'utf8'));
  }

  private log(...message) {
    if (this.verbose) {
      this.warn(...message);
    }
  }
  private warn(...message) {
    if (!message[0].startsWith('Warning')) {
      message[0] = `Warning: ${message[0]}`;
    }
    console.warn(...message);
  }

  /**
   * Convert the OpenAPI document to 3.0
   * @returns the converted document. The input is not modified.
   */
  public convert(): object {
    this.log('Converting from OpenAPI 3.1 to 3.0');
    this.openapi30.openapi = '3.0.3';
    this.convertSchemaRef();
    this.simplifyNonSchemaRef();
    this.convertSecuritySchemes();
    this.convertJsonSchemaExamples();
    this.convertConstToEnum();
    return this.openapi30;
  }

  /**
   * OpenAPI 3.1 uses JSON Schema 2020-12 which allows schema `examples`;
   * OpenAPI 3.0 uses JSON Scheme Draft 7 which only allows `example`.
   * Replace all `examples` with `example`, using `examples[0]`
   */
  convertJsonSchemaExamples() {
    const schemaVisitor: SchemaVisitor = (schema: SchemaObject): SchemaObject => {
      for (const key in schema) {
        const subSchema = schema[key];
        if (subSchema !== null && typeof subSchema === 'object') {
          if (key === 'examples') {
            const examples = schema['examples'];
            if (Array.isArray(examples) && examples.length > 0) {
              delete schema['examples'];
              const first = examples[0];
              if (
                this.deleteExampleWithId &&
                first != null &&
                typeof first === 'object' &&
                first.hasOwnProperty('id')
              ) {
                this.log(`Deleted schema example with \`id\` property:\n${this.json(examples)}`);
              } else {
                schema['example'] = first;
                this.log(`Replaces examples with examples[0]. Old examples:\n${this.json(examples)}`);
              }
              // TODO: Add an else here to check example for `id` and delete the example if this.deleteExampleWithId
              // We've put most of those in `examples` so this is probably not needed, but it would be more robust.
            }
          } else {
            schema[key] = walkObject(subSchema, schemaVisitor);
          }
        }
      }
      return schema;
    };
    visitSchemaObjects(this.openapi30, schemaVisitor);
  }

  /**
   * OpenAPI 3.1 uses JSON Schema 2020-12 which allows `const`
   * OpenAPI 3.0 uses JSON Scheme Draft 7 which only allows `enum`.
   * Replace all `const: value` with `enum: [ value ]`
   */
  convertConstToEnum() {
    const schemaVisitor: SchemaVisitor = (schema: SchemaObject): SchemaObject => {
      for (const key in schema) {
        if (key === 'const') {
          const constant = schema['const'];
          delete schema['const'];
          schema['enum'] = [constant];
        } else {
          const subSchema = schema[key];

          if (subSchema !== null && typeof subSchema === 'object') {
            schema[key] = walkObject(subSchema, schemaVisitor);
          }
        }
      }
      return schema;
    };
    visitSchemaObjects(this.openapi30, schemaVisitor);
  }

  private json(x) {
    return JSON.stringify(x, null, 2);
  }

  /**
   * OpenAPI 3.1 defines a new `openIdConnect` security scheme.
   * Down-convert the scheme to `oauth2` / authorization code flow.
   * Collect all the scopes used in any security requirements within
   * operations and add them to the scheme. Also define the
   * URLs to the `authorizationUrl` and `tokenUrl` of `oauth2`.
   */
  convertSecuritySchemes() {
    const oauth2Scopes = (schemeName: string): object => {
      const scopes = {};
      const paths = this.openapi30?.paths;
      for (const path in paths) {
        for (const op in paths[path]) {
          if (op === 'parameters') {
            continue;
          }
          const operation = paths[path][op];
          const sec = operation?.security as object[];
          sec.forEach((s) => {
            const requirement = s?.[schemeName] as string[];
            if (requirement) {
              requirement.forEach((scope) => {
                scopes[scope] = this.scopeDescriptions[scope] || `TODO: describe the '${scope}' scope`;
              });
            }
          });
        }
      }
      return scopes;
    };
    const schemes = this.openapi30?.components?.['securitySchemes'] || {};
    for (const schemeName in schemes) {
      const scheme = schemes[schemeName];
      const type = scheme.type;
      if (type === 'openIdConnect') {
        this.log(`Converting openIdConnect security scheme to oauth2/authorizationCode`);
        scheme.type = 'oauth2';
        const openIdConnectUrl = scheme.openIdConnectUrl;
        scheme.description = `OAuth2 Authorization Code Flow. The client may
          GET the OpenID Connect configuration JSON from \`${openIdConnectUrl}\`
          to get the correct \`authorizationUrl\` and \`tokenUrl\`.`;
        delete scheme.openIdConnectUrl;
        const scopes = oauth2Scopes(schemeName);
        scheme.flows = {
          authorizationCode: {
            // TODO: add options for these URLs
            authorizationUrl: this.authorizationUrl,
            tokenUrl: this.tokenUrl,
            scopes: scopes,
          },
        };
      }
    }
  }

  /**
   * Find remaining OpenAPI 3.0 [Reference Objects](https://github.com/OAI/OpenAPI-Specification/blob/main/versions/3.1.0.md#referenceObject)
   * and down convert them to [JSON Reference](https://tools.ietf.org/html/draft-pbryan-zyp-json-ref-03) objects
   * with _only_ a `$ref` property.
   */
  simplifyNonSchemaRef() {
    visitRefObjects(this.openapi30, (node: RefObject): JsonNode => {
      if (Object.keys(node).length === 1) {
        return node;
      } else {
        this.log(`Down convert reference object to JSON Reference:\n${JSON.stringify(node, null, 3)}`);
        Object.keys(node)
          .filter((key) => key !== '$ref')
          .forEach((key) => delete node[key]);
        return node;
      }
    });
  }

  // This transformation ends up breaking openapi-generator
  // SDK gen (typescript-axios, typescript-angular)
  // so it is disabled unless the `allOfTransform` option is `true`.

  convertSchemaRef() {
    /**
     * In a JSON Schema, replace `{ blah blah, $ref: "uri"}`
     * with `{ blah blah, allOf: [ $ref: "uri" ]}`
     * @param object an object that may contain JSON schemas (directly
     * or in sub-objects)
     */
    const simplifyRefObjectsInSchemas = (object: SchemaObject): SchemaObject => {
      return visitRefObjects(object, (node: RefObject): JsonNode => {
        if (Object.keys(node).length === 1) {
          return node;
        } else {
          this.log(`Converting JSON Schema $ref ${this.json(node)} to allOf: [ $ref ]`);
          node['allOf'] = [{ $ref: node.$ref }];
          delete node.$ref;
          return node;
        }
      });
    };

    if (this.allOfTransform) {
      visitSchemaObjects(this.openapi30, (schema: SchemaObject): SchemaObject => {
        return simplifyRefObjectsInSchemas(schema);
      });
    }
  }

  public static deepClone(obj: object): object {
    return v8.deserialize(v8.serialize(obj)); // kinda simple way to clone, but it works...
  }
}
