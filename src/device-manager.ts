import { Robot, ActionableError } from "./robot";
import { AndroidRobot, AndroidDeviceManager } from "./android";
import { IosManager, IosRobot } from "./ios";
import { Mobilecli } from "./mobilecli";
import { MobileDevice } from "./mobile-device";

const mobilecli = new Mobilecli();

export interface DeviceInfo {
	id: string;
	name: string;
	platform: "android" | "ios";
	type: "real" | "emulator" | "simulator";
	version: string;
}

export function ensureMobilecliAvailable(): void {
	try {
		const version = mobilecli.getVersion();
		if (version.startsWith("failed")) {
			throw new Error("mobilecli version check failed");
		}
	} catch (error: any) {
		throw new ActionableError(
			"mobilecli is not available or not working properly. Please review the documentation at https://github.com/mobile-next/mobile-mcp/wiki for installation instructions"
		);
	}
}

export function getRobotFromDevice(deviceId: string): Robot {
	ensureMobilecliAvailable();

	const iosManager = new IosManager();
	const iosDevices = iosManager.listDevices();
	if (iosDevices.find(d => d.deviceId === deviceId)) {
		return new IosRobot(deviceId);
	}

	const androidManager = new AndroidDeviceManager();
	const androidDevices = androidManager.getConnectedDevices();
	if (androidDevices.find(d => d.deviceId === deviceId)) {
		return new AndroidRobot(deviceId);
	}

	const response = mobilecli.getDevices({
		platform: "ios",
		type: "simulator",
		includeOffline: false,
	});

	if (response.status === "ok" && response.data?.devices) {
		for (const device of response.data.devices) {
			if (device.id === deviceId) {
				return new MobileDevice(deviceId);
			}
		}
	}

	throw new ActionableError(
		`Device "${deviceId}" not found. Use --list-devices to see available devices.`
	);
}

export function listAvailableDevices(): DeviceInfo[] {
	ensureMobilecliAvailable();
	const devices: DeviceInfo[] = [];

	try {
		const androidManager = new AndroidDeviceManager();
		const androidDevices = androidManager.getConnectedDevicesWithDetails();
		for (const d of androidDevices) {
			devices.push({
				id: d.deviceId,
				name: d.name,
				platform: "android",
				type: "emulator",
				version: d.version,
			});
		}
	} catch (e) { /* skip if adb not available */ }

	try {
		const iosManager = new IosManager();
		const iosDevices = iosManager.listDevicesWithDetails();
		for (const d of iosDevices) {
			devices.push({
				id: d.deviceId,
				name: d.deviceName,
				platform: "ios",
				type: "real",
				version: d.version,
			});
		}
	} catch (e) { /* skip if go-ios not available */ }

	const response = mobilecli.getDevices({
		platform: "ios",
		type: "simulator",
		includeOffline: false,
	});
	if (response.status === "ok" && response.data?.devices) {
		for (const d of response.data.devices) {
			devices.push({
				id: d.id,
				name: d.name,
				platform: d.platform,
				type: d.type,
				version: d.version,
			});
		}
	}

	return devices;
}

export { mobilecli };
