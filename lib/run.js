"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.run_deploy = exports.fromLiteralsToFromFile = void 0;
const core = require("@actions/core");
const command_1 = require("@actions/core/lib/command");
const path = require("path");
const fs = require("fs");
const io = require("@actions/io");
const toolCache = require("@actions/tool-cache");
const toolrunner_1 = require("@actions/exec/lib/toolrunner");
const jsyaml = require("js-yaml");
const util = require("util");
const toolrunner_2 = require("@actions/exec/lib/toolrunner");
const kubectl_util_1 = require("./utilities/kubectl-util");
const utility_1 = require("./utilities/utility");
const kubectl_object_model_1 = require("./kubectl-object-model");
const deployment_helper_1 = require("./utilities/strategy-helpers/deployment-helper");
const promote_1 = require("./actions/promote");
const reject_1 = require("./actions/reject");
//----------------------------------------- Set Context ---------------------------------------------
function getKubeconfig() {
    const method = core.getInput('method', { required: true });
    if (method == 'kubeconfig') {
        const kubeconfig = core.getInput('kubeconfig', { required: true });
        core.debug("Setting context using kubeconfig");
        return kubeconfig;
    }
    else if (method == 'service-account') {
        const clusterUrl = core.getInput('k8s-url', { required: true });
        core.debug("Found clusterUrl, creating kubeconfig using certificate and token");
        let k8sSecret = core.getInput('k8s-secret', { required: true });
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
function getKubectlPath() {
    return __awaiter(this, void 0, void 0, function* () {
        let kubectlPath = yield io.which('kubectl', false);
        if (!kubectlPath) {
            const allVersions = toolCache.findAllVersions('kubectl');
            kubectlPath = allVersions.length > 0 ? toolCache.find('kubectl', allVersions[0]) : '';
            if (!kubectlPath) {
                throw new Error('Kubectl is not installed');
            }
            kubectlPath = path.join(kubectlPath, `kubectl${utility_1.getExecutableExtension()}`);
        }
        return kubectlPath;
    });
}
function setContext() {
    return __awaiter(this, void 0, void 0, function* () {
        let context = core.getInput('context');
        if (context) {
            const kubectlPath = yield getKubectlPath();
            let toolRunner = new toolrunner_1.ToolRunner(kubectlPath, ['config', 'use-context', context]);
            yield toolRunner.exec();
            toolRunner = new toolrunner_1.ToolRunner(kubectlPath, ['config', 'current-context']);
            yield toolRunner.exec();
        }
    });
}
function run_set_context() {
    return __awaiter(this, void 0, void 0, function* () {
        let kubeconfig = getKubeconfig();
        const runnerTempDirectory = process.env['RUNNER_TEMP']; // Using process.env until the core libs are updated
        const kubeconfigPath = path.join(runnerTempDirectory, `kubeconfig_${Date.now()}`);
        core.debug(`Writing kubeconfig contents to ${kubeconfigPath}`);
        fs.writeFileSync(kubeconfigPath, kubeconfig);
        command_1.issueCommand('set-env', { name: 'KUBECONFIG' }, kubeconfigPath);
        console.log('KUBECONFIG environment variable is set');
        yield setContext();
        console.log('1');
    });
}
//run_set_context().catch(core.setFailed);
//-------------------------------------------------- Create Secret --------------------------------------------------
const fileUtility = require("./file.utility");
let kubectlPath = "";
function checkAndSetKubectlPath() {
    return __awaiter(this, void 0, void 0, function* () {
        kubectlPath = yield io.which('kubectl', false);
        if (kubectlPath) {
            return;
        }
        const allVersions = toolCache.findAllVersions('kubectl');
        kubectlPath = allVersions.length > 0 ? toolCache.find('kubectl', allVersions[0]) : '';
        if (!kubectlPath) {
            throw new Error('Kubectl is not installed');
        }
        kubectlPath = path.join(kubectlPath, `kubectl${utility_1.getExecutableExtension()}`);
    });
}
/*
function getExecutableExtension(): string {
    if (os.type().match(/^Win/)) {
        return '.exe';
    }

    return '';
}
*/
function createSecret() {
    return __awaiter(this, void 0, void 0, function* () {
        const typeOfSecret = core.getInput('secret-type', { required: true });
        const secretName = core.getInput('secret-name', { required: true });
        const namespace = core.getInput('namespace');
        yield deleteSecret(namespace, secretName);
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
        const toolRunner = new toolrunner_1.ToolRunner(kubectlPath, args);
        const code = yield toolRunner.exec();
        if (code != 0) {
            throw new Error('Secret create failed.');
        }
        core.setOutput('secret-name', secretName);
    });
}
function deleteSecret(namespace, secretName) {
    return __awaiter(this, void 0, void 0, function* () {
        let args = ['delete', 'secret', secretName];
        if (namespace) {
            args.push('-n', namespace);
        }
        const toolRunner = new toolrunner_1.ToolRunner(kubectlPath, args, { failOnStdErr: false, ignoreReturnCode: true, silent: true });
        yield toolRunner.exec();
        core.debug(`Deleting ${secretName} if already exist.`);
    });
}
function getDockerSecretArguments(secretName) {
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
function getGenericSecretArguments(secretName) {
    const secretArguments = core.getInput('arguments');
    const parsedArgument = fromLiteralsToFromFile(secretArguments);
    let args = ['create', 'secret', 'generic', secretName];
    args.push(...toolrunner_2.argStringToArray(parsedArgument));
    return args;
}
/**
 * Takes a valid kubectl arguments and parses --from-literal to --from-file
 * @param secretArguments
 */
function fromLiteralsToFromFile(secretArguments) {
    const parsedArgument = secretArguments.split("--").reduce((argumentsBuilder, argument) => {
        if (argument && !argument.startsWith("from-literal=")) {
            argumentsBuilder = argumentsBuilder.trim() + " --" + argument;
        }
        else if (argument && argument.startsWith("from-literal=")) {
            const command = argument.substring("from-literal=".length);
            /* The command starting after 'from-literal=' contanis a 'key=value' format. The secret itself might contain a '=',
            Hence the substring than a split*/
            if (command.indexOf("=") == -1)
                throw new Error('Invalid from-literal input. It should contain a key and value');
            const secretName = command.substring(0, command.indexOf("=")).trim();
            const secretValue = command.substring(command.indexOf("=") + 1).trim();
            //Secret with spaces will be enclosed in quotes -> "secret "
            if (secretValue && secretValue.indexOf("\"") == 0 && secretValue.lastIndexOf("\"") == secretValue.length - 1) {
                const secret = secretValue.substring(1, secretValue.lastIndexOf("\""));
                argumentsBuilder += " --from-file=" + fileUtility.createFile(secretName, secret, true);
            }
            else {
                const secret = secretValue.substring(0, secretValue.indexOf(" ") == -1 ? secretValue.length : secretValue.indexOf(" "));
                argumentsBuilder += " --from-file=" + fileUtility.createFile(secretName, secret, true);
            }
        }
        return argumentsBuilder;
    });
    return parsedArgument.trim();
}
exports.fromLiteralsToFromFile = fromLiteralsToFromFile;
function checkClusterContext() {
    console.log('check context');
    if (!process.env["KUBECONFIG"]) {
        throw new Error('Cluster context not set. Use k8s-set-context/aks-set-context action to set cluster context');
    }
}
function run_create_secret() {
    return __awaiter(this, void 0, void 0, function* () {
        checkClusterContext();
        yield checkAndSetKubectlPath();
        yield createSecret();
        console.log('2');
    });
}
//run_create_secret().catch(core.setFailed);
//--------------------------------------------------- Deploy ------------------------------------------------------------
kubectlPath = "";
function setKubectlPath() {
    return __awaiter(this, void 0, void 0, function* () {
        if (core.getInput('kubectl-version')) {
            const version = core.getInput('kubectl-version');
            kubectlPath = toolCache.find('kubectl', version);
            if (!kubectlPath) {
                kubectlPath = yield installKubectl(version);
            }
        }
        else {
            kubectlPath = yield io.which('kubectl', false);
            if (!kubectlPath) {
                const allVersions = toolCache.findAllVersions('kubectl');
                kubectlPath = allVersions.length > 0 ? toolCache.find('kubectl', allVersions[0]) : '';
                if (!kubectlPath) {
                    throw new Error('Kubectl is not installed, either add install-kubectl action or provide "kubectl-version" input to download kubectl');
                }
                kubectlPath = path.join(kubectlPath, `kubectl${utility_1.getExecutableExtension()}`);
            }
        }
    });
}
function installKubectl(version) {
    return __awaiter(this, void 0, void 0, function* () {
        if (utility_1.isEqual(version, 'latest')) {
            version = yield kubectl_util_1.getStableKubectlVersion();
        }
        return yield kubectl_util_1.downloadKubectl(version);
    });
}
/*
function checkClusterContext() {
    if (!process.env["KUBECONFIG"]) {
        throw new Error('Cluster context not set. Use k8ssetcontext action to set cluster context');
    }
}
*/
function run_deploy() {
    return __awaiter(this, void 0, void 0, function* () {
        checkClusterContext();
        yield setKubectlPath();
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
            console.log("strategy: ", strategy);
            yield deployment_helper_1.deploy(new kubectl_object_model_1.Kubectl(kubectlPath, namespace), manifests, strategy);
        }
        else if (action === 'promote') {
            yield promote_1.promote(true);
        }
        else if (action === 'reject') {
            yield reject_1.reject(true);
        }
        else {
            core.setFailed('Not a valid action. The allowed actions are deploy, promote, reject');
        }
    });
}
exports.run_deploy = run_deploy;
//run_deploy().catch(core.setFailed);
function run() {
    return __awaiter(this, void 0, void 0, function* () {
        run_set_context().catch(core.setFailed);
        run_create_secret().catch(core.setFailed);
        run_deploy().catch(core.setFailed);
        console.log('3');
    });
}
run().catch(core.setFailed);
