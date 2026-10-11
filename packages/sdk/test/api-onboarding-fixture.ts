/** Synthetic declaration shared by public-format and local execution fixtures.
 * The local adapter substitutes its loopback origin and fresh credential path. */
import type { ApiBindingV1 as ApiBinding } from '../src/control.ts';

export interface ApiOnboardingDeclaration {
  api: ApiBinding;
  priceMicroUsdc: string;
  validFrom: string;
  validUntil: string;
  credentialFile: string;
}

export const API_ONBOARDING_DECLARATION: ApiOnboardingDeclaration = Object.freeze({
  api: Object.freeze({version:'1',service:'catalog',operation:'lookup',method:'POST',
    origin:'https://catalog.example.com',path:'/lookup',request_max_bytes:'1048576',
    response_max_bytes:'1048576',timeout_seconds:'30',billing:'http_2xx_json'}),
  priceMicroUsdc:'250',validFrom:'1',validUntil:'4000000000',
  credentialFile:'/synthetic-api-onboarding/provider.key',
});
