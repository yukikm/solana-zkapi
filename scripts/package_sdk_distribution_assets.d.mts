export function packageDeploymentAssets(configuration:string,output:string):Promise<{
 schema:number;bundleSha256:string;manifestHash:string;publicFiles:number;totalBytes:number;
 networkActions:number;fundingActions:number;inferenceActions:number;
}>;
