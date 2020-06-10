import * as core from '@actions/core';
import { issueCommand } from '@actions/core/lib/command';
import * as path from 'path';
import * as fs from 'fs';
import * as io from '@actions/io';
import * as toolCache from '@actions/tool-cache';
import * as os from 'os';
import { ToolRunner } from "@actions/exec/lib/toolrunner";
import * as jsyaml from 'js-yaml';
import * as util from 'util';

import { argStringToArray } from "@actions/exec/lib/toolrunner";

import { downloadKubectl, getStableKubectlVersion } from "./utilities/kubectl-util";
import { getExecutableExtension, isEqual } from "./utilities/utility";

import { Kubectl } from './kubectl-object-model';
import { deploy } from './utilities/strategy-helpers/deployment-helper';
import { promote } from './actions/promote';
import { reject } from './actions/reject';


//----------------------------------------- Set Context ---------------------------------------------
function getKubeconfig(): string {
    const method =  core.getInput('method', {required: true});
    if (method == 'kubeconfig') {
        const kubeconfig = core.getInput('kubeconfig', {required : true});
        console.log('Printing kube config')
        console.log(kubeconfig)
        return kubeconfig;
    }
    else if (method == 'service-account') {
        const clusterUrl = core.getInput('k8s-url', { required: true });
        core.debug("Found clusterUrl, creating kubeconfig using certificate and token");
        let k8sSecret = core.getInput('k8s-secret', {required : true});
        var parsedk8sSecret = jsyaml.safeLoad(k8sSecret);
        let kubernetesServiceAccountSecretFieldNotPresent = 'The service acount secret yaml does not contain %s; field. Make sure that its present and try again.';
        if (!parsedk8sSecret) {
            throw Error("The service account secret yaml specified is invalid. Make sure that its a valid yaml and try again.");
        }

        if (!parsedk8sSecret.data) {
            throw Error(util.format(kubernetesServiceAccountSecretFieldNotPresent, "data"));
        }

        if (!parsedk8sSecret.data.token) {
            throw Error(util.format(kubernetesServiceAccountSecretFieldNotPresent, "data.token"));
        }

        if (!parsedk8sSecret.data["ca.crt"]) {
            throw Error(util.format(kubernetesServiceAccountSecretFieldNotPresent, "data[ca.crt]"));
        }

        const certAuth = parsedk8sSecret.data["ca.crt"];
        const token = Buffer.from(parsedk8sSecret.data.token, 'base64').toString();
        const kubeconfigObject = {
            "apiVersion": "v1",
            "kind": "Config",
            "clusters": [
                {
                    "cluster": {
                        "certificate-authority-data": certAuth,
                        "server": clusterUrl
                    }
                }
            ],
            "users": [
                {
                    "user": {
                        "token": token
                    }
                }
            ]
        };

        return JSON.stringify(kubeconfigObject);
    }
    else {
        throw Error("Invalid method specified. Acceptable values are kubeconfig and service-account.");
    }
}
/*
function getExecutableExtension(): string {
    if (os.type().match(/^Win/)) {
        return '.exe';
    }

    return '';
}
*/
async function getKubectlPath() {
    let kubectlPath = await io.which('kubectl', false);
    if (!kubectlPath) {
        const allVersions = toolCache.findAllVersions('kubectl');
        kubectlPath = allVersions.length > 0 ? toolCache.find('kubectl', allVersions[0]) : '';
        if (!kubectlPath) {
            throw new Error('Kubectl is not installed');
        }

        kubectlPath = path.join(kubectlPath, `kubectl${getExecutableExtension()}`);
    }
    return kubectlPath;
}

async function setContext() {
    let context = core.getInput('context');
    if (context) {
        const kubectlPath = await getKubectlPath();
        let toolRunner = new ToolRunner(kubectlPath, ['config', 'use-context', context]);
        await toolRunner.exec();
        toolRunner = new ToolRunner(kubectlPath, ['config', 'current-context']);
        await toolRunner.exec();
    }
}

async function run_set_context() {
    let kubeconfig = getKubeconfig();
    const runnerTempDirectory = process.env['RUNNER_TEMP']; // Using process.env until the core libs are updated
    const kubeconfigPath = path.join(runnerTempDirectory, `kubeconfig_${Date.now()}`);
    core.debug(`Writing kubeconfig contents to ${kubeconfigPath}`);
    fs.writeFileSync(kubeconfigPath, kubeconfig);
    issueCommand('set-env', { name: 'KUBECONFIG' }, kubeconfigPath);
    console.log('KUBECONFIG environment variable is set');
    await setContext();
    console.log('1');
}

//-------------------------------------------------- Create Secret --------------------------------------------------

import fileUtility = require('./file.utility')

let kubectlPath = "";

async function checkAndSetKubectlPath() {
    kubectlPath = await io.which('kubectl', false);
    if (kubectlPath) {
        return;
    }

    const allVersions = toolCache.findAllVersions('kubectl');
    kubectlPath = allVersions.length > 0 ? toolCache.find('kubectl', allVersions[0]) : '';
    if (!kubectlPath) {
        throw new Error('Kubectl is not installed');
    }

    kubectlPath = path.join(kubectlPath, `kubectl${getExecutableExtension()}`);
}

/*
function getExecutableExtension(): string {
    if (os.type().match(/^Win/)) {
        return '.exe';
    }

    return '';
}
*/

async function createSecret() {
    const typeOfSecret = core.getInput('secret-type', { required: true });
    const secretName = core.getInput('secret-name', { required: true });
    const namespace = core.getInput('namespace');

    await deleteSecret(namespace, secretName);

    let args;
    if (typeOfSecret === "docker-registry") {
        args = getDockerSecretArguments(secretName);
    }
    else if (typeOfSecret === "generic") {
        args = getGenericSecretArguments(secretName);
    }
    else {
        throw new Error('Invalid secret-type input. It should be either docker-registry or generic');
    }

    if (namespace) {
        args.push('-n', namespace);
    }

    const toolRunner = new ToolRunner(kubectlPath, args);
    const code = await toolRunner.exec();
    if (code != 0) {
        throw new Error('Secret create failed.')
    }
    core.setOutput('secret-name', secretName);
}

async function deleteSecret(namespace: string, secretName: string) {
    let args = ['delete', 'secret', secretName];

    if (namespace) {
        args.push('-n', namespace);
    }

    const toolRunner = new ToolRunner(kubectlPath, args, { failOnStdErr: false, ignoreReturnCode: true, silent: true });
    await toolRunner.exec();
    core.debug(`Deleting ${secretName} if already exist.`);
}

function getDockerSecretArguments(secretName: string): string[] {
    const userName = core.getInput('container-registry-username');
    const password = core.getInput('container-registry-password');
    const server = core.getInput('container-registry-url');
    let email = core.getInput('container-registry-email');

    let args = ['create', 'secret', 'docker-registry', secretName, '--docker-username', userName, '--docker-password', password];

    if (server) {
        args.push('--docker-server', server);
    }

    if (!email) {
        email = ' ';
    }

    args.push('--docker-email', email);
    return args;
}

function getGenericSecretArguments(secretName: string): string[] {
    const secretArguments = core.getInput('arguments');
    const parsedArgument = fromLiteralsToFromFile(secretArguments);
    let args = ['create', 'secret', 'generic', secretName];
    args.push(...argStringToArray(parsedArgument));
    return args;
}

/**
 * Takes a valid kubectl arguments and parses --from-literal to --from-file
 * @param secretArguments 
 */
export function fromLiteralsToFromFile(secretArguments: string): string {
    const parsedArgument = secretArguments.split("--").reduce((argumentsBuilder, argument) => {
        if (argument && !argument.startsWith("from-literal=")) {
            argumentsBuilder = argumentsBuilder.trim() + " --" + argument;
        } else if (argument && argument.startsWith("from-literal=")) {
            const command = argument.substring("from-literal=".length);
            /* The command starting after 'from-literal=' contanis a 'key=value' format. The secret itself might contain a '=', 
            Hence the substring than a split*/
            if (command.indexOf("=") == -1) throw new Error('Invalid from-literal input. It should contain a key and value');
            const secretName = command.substring(0, command.indexOf("=")).trim();
            const secretValue = command.substring(command.indexOf("=") + 1).trim();
            //Secret with spaces will be enclosed in quotes -> "secret "
            if (secretValue && secretValue.indexOf("\"") == 0 && secretValue.lastIndexOf("\"") == secretValue.length - 1) {
                const secret = secretValue.substring(1, secretValue.lastIndexOf("\""));
                argumentsBuilder += " --from-file=" + fileUtility.createFile(secretName, secret, true);
            } else {
                const secret = secretValue.substring(0, secretValue.indexOf(" ") == -1 ? secretValue.length : secretValue.indexOf(" "));
                argumentsBuilder += " --from-file=" + fileUtility.createFile(secretName, secret, true);
            }
        }
        return argumentsBuilder;
    });
    return parsedArgument.trim();
}

function checkClusterContext() {
    console.log('Printing environment variables')
    console.log(process.env);
    if (!process.env["INPUT_KUBECONFIG"]) {
        throw new Error('Cluster context not set. Use k8s-set-context/aks-set-context action to set cluster context');
    }
}

async function run_create_secret() {
    checkClusterContext();
    await checkAndSetKubectlPath();
    await createSecret();
    console.log('2');
}

//run_create_secret().catch(core.setFailed);


//--------------------------------------------------- Deploy ------------------------------------------------------------

kubectlPath = "";

async function setKubectlPath() {
    if (core.getInput('kubectl-version')) {
        const version = core.getInput('kubectl-version');
        kubectlPath = toolCache.find('kubectl', version);
        if (!kubectlPath) {
            kubectlPath = await installKubectl(version);
        }
    } else {
        kubectlPath = await io.which('kubectl', false);
        if (!kubectlPath) {
            const allVersions = toolCache.findAllVersions('kubectl');
            kubectlPath = allVersions.length > 0 ? toolCache.find('kubectl', allVersions[0]) : '';
            if (!kubectlPath) {
                throw new Error('Kubectl is not installed, either add install-kubectl action or provide "kubectl-version" input to download kubectl');
            }
            kubectlPath = path.join(kubectlPath, `kubectl${getExecutableExtension()}`);
        }
    }
}

async function installKubectl(version: string) {
    if (isEqual(version, 'latest')) {
        version = await getStableKubectlVersion();
    }
    return await downloadKubectl(version);
}

export async function run_deploy() {
    checkClusterContext();
    await setKubectlPath();
    let manifestsInput = core.getInput('manifests');
    if (!manifestsInput) {
        core.setFailed('No manifests supplied to deploy');
        return;
    }
    let namespace = core.getInput('namespace');
    if (!namespace) {
        namespace = 'default';
    }
    let action = core.getInput('action');
    let manifests = manifestsInput.split('\n');

    if (action === 'deploy') {
        let strategy = core.getInput('strategy');
        console.log("strategy: ", strategy)
        await deploy(new Kubectl(kubectlPath, namespace), manifests, strategy);
    }
    else if (action === 'promote') {
        await promote(true);
    }
    else if (action === 'reject') {
        await reject(true);
    }
    else {
        core.setFailed('Not a valid action. The allowed actions are deploy, promote, reject');
    }
}

async function run(){
    console.log('Starting the run function')
    await run_set_context().catch(core.setFailed);
    console.log('Finished set context function')
    await run_create_secret().catch(core.setFailed);
    await run_deploy().catch(core.setFailed);
}

run().catch(core.setFailed);
