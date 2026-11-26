/**
 * Raises every CocoaPods target's IPHONEOS_DEPLOYMENT_TARGET to at least
 * MIN_TARGET. Current Xcode on EAS ("latest" image) rejects pods that still
 * declare 12.x/13.x (RevenueCat, PurchasesHybridCommon, ReachabilitySwift,
 * RNCAsyncStorage resources) with "supported range is 15.0 to ...".
 */
const { withDangerousMod } = require("expo/config-plugins");
const fs = require("node:fs");
const path = require("node:path");

const MIN_TARGET = "15.1";
const MARKER = "# withPodsDeploymentTarget";

function patchPodfile(src) {
	if (src.includes(MARKER)) return src;
	const snippet = `
    ${MARKER}
    installer.pods_project.targets.each do |target|
      target.build_configurations.each do |bc|
        current = bc.build_settings['IPHONEOS_DEPLOYMENT_TARGET']
        if current.nil? || current.to_f < ${MIN_TARGET}
          bc.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = '${MIN_TARGET}'
        end
      end
    end
`;
	const anchor = /post_install do \|installer\|\n/;
	if (!anchor.test(src)) {
		throw new Error(
			"withPodsDeploymentTarget: post_install block not found in Podfile",
		);
	}
	return src.replace(anchor, (m) => m + snippet);
}

module.exports = function withPodsDeploymentTarget(config) {
	return withDangerousMod(config, [
		"ios",
		async (cfg) => {
			const podfile = path.join(cfg.modRequest.platformProjectRoot, "Podfile");
			fs.writeFileSync(podfile, patchPodfile(fs.readFileSync(podfile, "utf8")));
			return cfg;
		},
	]);
};
module.exports.patchPodfile = patchPodfile;
