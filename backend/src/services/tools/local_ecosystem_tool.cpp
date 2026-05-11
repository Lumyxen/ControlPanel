#include "services/tools/local_ecosystem_tool.h"

#include <algorithm>
#include <chrono>
#include <cctype>
#include <cstdint>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <string>
#include <vector>

#ifndef _WIN32
#include <sys/stat.h>
#include <sys/statvfs.h>
#include <sys/sysinfo.h>
#include <sys/utsname.h>
#include <unistd.h>
#endif

namespace fs = std::filesystem;

namespace {

std::string trimCopy(const std::string& value) {
    const auto start = value.find_first_not_of(" \t\r\n");
    if (start == std::string::npos) {
        return "";
    }
    const auto end = value.find_last_not_of(" \t\r\n");
    return value.substr(start, end - start + 1);
}

std::string stripQuotes(std::string value) {
    value = trimCopy(value);
    if (value.size() >= 2 && value.front() == '"' && value.back() == '"') {
        return value.substr(1, value.size() - 2);
    }
    return value;
}

std::vector<std::string> readLines(const fs::path& path, std::size_t maxLines = 2000) {
    std::vector<std::string> lines;
    std::ifstream file(path);
    if (!file.is_open()) {
        return lines;
    }

    std::string line;
    while (lines.size() < maxLines && std::getline(file, line)) {
        lines.push_back(line);
    }
    return lines;
}

Json::Value readKeyValueFile(const fs::path& path, char delimiter = '=') {
    Json::Value result(Json::objectValue);
    for (const auto& line : readLines(path)) {
        const std::string trimmed = trimCopy(line);
        if (trimmed.empty() || trimmed.front() == '#') {
            continue;
        }
        const auto separator = trimmed.find(delimiter);
        if (separator == std::string::npos) {
            continue;
        }
        const std::string key = trimCopy(trimmed.substr(0, separator));
        const std::string value = stripQuotes(trimmed.substr(separator + 1));
        if (!key.empty()) {
            result[key] = value;
        }
    }
    return result;
}

std::string readFirstLine(const fs::path& path) {
    std::ifstream file(path);
    std::string line;
    if (file.is_open() && std::getline(file, line)) {
        return trimCopy(line);
    }
    return "";
}

Json::Value makeArray(const std::vector<std::string>& values) {
    Json::Value result(Json::arrayValue);
    for (const auto& value : values) {
        if (!value.empty()) {
            result.append(value);
        }
    }
    return result;
}

bool pathExistsInPath(const std::string& executable) {
    const char* pathEnv = std::getenv("PATH");
    if (!pathEnv || executable.empty()) {
        return false;
    }

    std::stringstream stream(pathEnv);
    std::string directory;
    while (std::getline(stream, directory, ':')) {
        if (directory.empty()) {
            directory = ".";
        }
        std::error_code ec;
        if (fs::exists(fs::path(directory) / executable, ec)) {
            return true;
        }
    }
    return false;
}

Json::Value presentExecutables(const std::vector<std::string>& names) {
    Json::Value result(Json::arrayValue);
    for (const auto& name : names) {
        if (pathExistsInPath(name)) {
            result.append(name);
        }
    }
    return result;
}

std::string toLower(std::string value) {
    std::transform(value.begin(), value.end(), value.begin(), [](unsigned char ch) {
        return static_cast<char>(std::tolower(ch));
    });
    return value;
}

std::vector<unsigned char> readBinaryFile(const fs::path& path, std::size_t maxBytes = 65536) {
    std::ifstream file(path, std::ios::binary);
    if (!file.is_open()) {
        return {};
    }
    std::vector<unsigned char> bytes;
    bytes.reserve(std::min<std::size_t>(maxBytes, 4096));
    char ch = '\0';
    while (bytes.size() < maxBytes && file.get(ch)) {
        bytes.push_back(static_cast<unsigned char>(ch));
    }
    return bytes;
}

std::string normalizePciId(std::string value) {
    value = toLower(trimCopy(value));
    if (value.rfind("0x", 0) == 0) {
        value = value.substr(2);
    }
    if (value.empty()) {
        return "";
    }
    while (value.size() < 4) {
        value.insert(value.begin(), '0');
    }
    return value;
}

std::string restAfterToken(const std::string& line, const std::string& token) {
    if (line.size() <= token.size()) {
        return "";
    }
    return trimCopy(line.substr(token.size()));
}

struct PciNameLookup {
    std::string sourcePath;
    std::string vendorName;
    std::string deviceName;
    std::string subsystemName;
};

PciNameLookup lookupPciName(
    const std::string& vendorId,
    const std::string& deviceId,
    const std::string& subsystemVendorId,
    const std::string& subsystemDeviceId) {
    const std::string targetVendor = normalizePciId(vendorId);
    const std::string targetDevice = normalizePciId(deviceId);
    const std::string targetSubsystemVendor = normalizePciId(subsystemVendorId);
    const std::string targetSubsystemDevice = normalizePciId(subsystemDeviceId);

    const std::vector<fs::path> candidates = {
        "/usr/share/hwdata/pci.ids",
        "/usr/share/misc/pci.ids",
        "/usr/share/pci.ids"
    };

    for (const auto& path : candidates) {
        std::ifstream file(path);
        if (!file.is_open()) {
            continue;
        }

        PciNameLookup result;
        result.sourcePath = path.string();
        bool inTargetVendor = false;
        bool inTargetDevice = false;
        std::string line;
        while (std::getline(file, line)) {
            if (line.empty() || line.front() == '#') {
                continue;
            }

            if (line.front() != '\t') {
                const std::string trimmed = trimCopy(line);
                const auto separator = trimmed.find_first_of(" \t");
                if (separator == std::string::npos) {
                    inTargetVendor = false;
                    inTargetDevice = false;
                    continue;
                }
                const std::string id = normalizePciId(trimmed.substr(0, separator));
                inTargetVendor = id == targetVendor;
                inTargetDevice = false;
                if (inTargetVendor) {
                    result.vendorName = trimCopy(trimmed.substr(separator + 1));
                } else if (!result.vendorName.empty() && !result.deviceName.empty()) {
                    return result;
                }
                continue;
            }

            if (!inTargetVendor) {
                continue;
            }

            if (line.size() < 2 || line[1] != '\t') {
                const std::string trimmed = trimCopy(line);
                const auto separator = trimmed.find_first_of(" \t");
                if (separator == std::string::npos) {
                    inTargetDevice = false;
                    continue;
                }
                const std::string id = normalizePciId(trimmed.substr(0, separator));
                inTargetDevice = id == targetDevice;
                if (inTargetDevice) {
                    result.deviceName = trimCopy(trimmed.substr(separator + 1));
                    if (targetSubsystemVendor.empty() || targetSubsystemDevice.empty()) {
                        return result;
                    }
                } else if (!result.deviceName.empty()) {
                    return result;
                }
                continue;
            }

            if (!inTargetDevice || targetSubsystemVendor.empty() || targetSubsystemDevice.empty()) {
                continue;
            }

            std::istringstream stream(trimCopy(line));
            std::string subVendor;
            std::string subDevice;
            stream >> subVendor >> subDevice;
            if (normalizePciId(subVendor) == targetSubsystemVendor &&
                normalizePciId(subDevice) == targetSubsystemDevice) {
                const std::string pair = subVendor + " " + subDevice;
                result.subsystemName = restAfterToken(trimCopy(line), pair);
                return result;
            }
        }

        if (!result.vendorName.empty() || !result.deviceName.empty()) {
            return result;
        }
    }

    return {};
}

std::string pciVendorName(const std::string& vendorId) {
    if (vendorId == "0x10de") return "NVIDIA";
    if (vendorId == "0x1002" || vendorId == "0x1022") return "AMD";
    if (vendorId == "0x8086") return "Intel";
    if (vendorId == "0x1af4") return "Virtio";
    if (vendorId == "0x1234") return "Bochs/QEMU";
    if (vendorId == "0x15ad") return "VMware";
    if (vendorId == "0x1414") return "Microsoft";
    return "";
}

std::string memoryFormFactorName(int value) {
    switch (value) {
    case 0x03: return "SIMM";
    case 0x04: return "SIP";
    case 0x05: return "Chip";
    case 0x06: return "DIP";
    case 0x07: return "ZIP";
    case 0x08: return "Proprietary Card";
    case 0x09: return "DIMM";
    case 0x0a: return "TSOP";
    case 0x0b: return "Row of chips";
    case 0x0c: return "RIMM";
    case 0x0d: return "SODIMM";
    case 0x0e: return "SRIMM";
    case 0x0f: return "FB-DIMM";
    default: return "";
    }
}

std::string memoryTypeName(int value) {
    switch (value) {
    case 0x03: return "DRAM";
    case 0x04: return "EDRAM";
    case 0x05: return "VRAM";
    case 0x06: return "SRAM";
    case 0x07: return "RAM";
    case 0x08: return "ROM";
    case 0x09: return "Flash";
    case 0x0a: return "EEPROM";
    case 0x0b: return "FEPROM";
    case 0x0c: return "EPROM";
    case 0x0d: return "CDRAM";
    case 0x0e: return "3DRAM";
    case 0x0f: return "SDRAM";
    case 0x10: return "SGRAM";
    case 0x11: return "RDRAM";
    case 0x12: return "DDR";
    case 0x13: return "DDR2";
    case 0x14: return "DDR2 FB-DIMM";
    case 0x18: return "DDR3";
    case 0x19: return "FBD2";
    case 0x1a: return "DDR4";
    case 0x1b: return "LPDDR";
    case 0x1c: return "LPDDR2";
    case 0x1d: return "LPDDR3";
    case 0x1e: return "LPDDR4";
    case 0x1f: return "Logical non-volatile device";
    case 0x20: return "HBM";
    case 0x21: return "HBM2";
    case 0x22: return "DDR5";
    case 0x23: return "LPDDR5";
    case 0x24: return "HBM3";
    default: return "";
    }
}

std::string dmiStringAt(const std::vector<unsigned char>& raw, std::size_t formattedLength, unsigned int index) {
    if (index == 0 || formattedLength >= raw.size()) {
        return "";
    }

    std::size_t pos = formattedLength;
    unsigned int current = 1;
    while (pos < raw.size()) {
        const std::size_t start = pos;
        while (pos < raw.size() && raw[pos] != '\0') {
            ++pos;
        }
        if (pos == start) {
            break;
        }
        if (current == index) {
            return trimCopy(std::string(reinterpret_cast<const char*>(raw.data() + start), pos - start));
        }
        ++current;
        ++pos;
    }
    return "";
}

std::uint16_t le16(const std::vector<unsigned char>& raw, std::size_t offset) {
    if (offset + 1 >= raw.size()) {
        return 0;
    }
    return static_cast<std::uint16_t>(raw[offset] | (raw[offset + 1] << 8));
}

std::uint32_t le32(const std::vector<unsigned char>& raw, std::size_t offset) {
    if (offset + 3 >= raw.size()) {
        return 0;
    }
    return static_cast<std::uint32_t>(
        raw[offset] |
        (raw[offset + 1] << 8) |
        (raw[offset + 2] << 16) |
        (raw[offset + 3] << 24));
}

Json::Value collectTimestampFromStat(const fs::path& path, const std::string& label) {
    Json::Value result(Json::objectValue);
    result["source"] = label;
    result["path"] = path.string();
#ifndef _WIN32
    struct stat info {};
    if (stat(path.c_str(), &info) == 0) {
        result["unix_seconds"] = static_cast<Json::Int64>(info.st_ctime);
        const auto now = std::chrono::system_clock::to_time_t(std::chrono::system_clock::now());
        if (now > info.st_ctime) {
            result["approx_age_days"] = static_cast<Json::Int64>((now - info.st_ctime) / 86400);
        }
    } else {
        result["available"] = false;
    }
#else
    result["available"] = false;
#endif
    return result;
}

Json::Value collectOs() {
    Json::Value os(Json::objectValue);
#ifdef _WIN32
    os["type"] = "windows";
#else
#if defined(__linux__)
    os["type"] = "linux";
#elif defined(__APPLE__)
    os["type"] = "macos";
#else
    os["type"] = "unix";
#endif
    Json::Value release = readKeyValueFile("/etc/os-release");
    if (release.isObject() && !release.empty()) {
        os["distribution"]["name"] = release.get("NAME", "").asString();
        os["distribution"]["id"] = release.get("ID", "").asString();
        os["distribution"]["version"] = release.get("VERSION", "").asString();
        os["distribution"]["version_id"] = release.get("VERSION_ID", "").asString();
        os["distribution"]["pretty_name"] = release.get("PRETTY_NAME", "").asString();
    }

    struct utsname uts {};
    if (uname(&uts) == 0) {
        os["kernel"]["sysname"] = uts.sysname;
        os["kernel"]["release"] = uts.release;
        os["kernel"]["version"] = uts.version;
        os["kernel"]["machine"] = uts.machine;
        os["kernel"]["node_name"] = uts.nodename;
    }
#endif
    return os;
}

Json::Value collectAge() {
    Json::Value age(Json::objectValue);
    age["note"] = "Best-effort local estimate; Linux does not expose a universal install date.";
#ifndef _WIN32
    if (fs::exists("/var/log/installer")) {
        age["candidates"].append(collectTimestampFromStat("/var/log/installer", "installer_log_directory_ctime"));
    }
    if (fs::exists("/etc/machine-id")) {
        age["candidates"].append(collectTimestampFromStat("/etc/machine-id", "machine_id_ctime"));
    }
    age["candidates"].append(collectTimestampFromStat("/", "root_filesystem_ctime"));
#endif
    return age;
}

Json::Value collectCpu() {
    Json::Value cpu(Json::objectValue);
#ifndef _WIN32
    long processors = sysconf(_SC_NPROCESSORS_ONLN);
    if (processors > 0) {
        cpu["logical_cores"] = static_cast<Json::Int64>(processors);
    }

    std::string model;
    std::string vendor;
    int cpuEntries = 0;
    for (const auto& line : readLines("/proc/cpuinfo", 1000)) {
        const auto separator = line.find(':');
        if (separator == std::string::npos) {
            continue;
        }
        const std::string key = trimCopy(line.substr(0, separator));
        const std::string value = trimCopy(line.substr(separator + 1));
        if ((key == "model name" || key == "Hardware" || key == "Processor") && model.empty()) {
            model = value;
        } else if ((key == "vendor_id" || key == "CPU implementer") && vendor.empty()) {
            vendor = value;
        } else if (key == "processor") {
            ++cpuEntries;
        }
    }
    if (!model.empty()) {
        cpu["model"] = model;
    }
    if (!vendor.empty()) {
        cpu["vendor"] = vendor;
    }
    if (cpuEntries > 0) {
        cpu["reported_processors"] = cpuEntries;
    }
#endif
    return cpu;
}

Json::Value collectMemory() {
    Json::Value memory(Json::objectValue);
#ifndef _WIN32
    struct sysinfo info {};
    if (sysinfo(&info) == 0) {
        memory["total_bytes"] = static_cast<Json::UInt64>(info.totalram) * info.mem_unit;
        memory["free_bytes"] = static_cast<Json::UInt64>(info.freeram) * info.mem_unit;
        memory["available_swap_bytes"] = static_cast<Json::UInt64>(info.freeswap) * info.mem_unit;
        memory["total_swap_bytes"] = static_cast<Json::UInt64>(info.totalswap) * info.mem_unit;
    }

    Json::Value modules(Json::arrayValue);
    std::error_code ec;
    if (fs::exists("/sys/firmware/dmi/entries", ec)) {
        for (const auto& entry : fs::directory_iterator("/sys/firmware/dmi/entries", fs::directory_options::skip_permission_denied, ec)) {
            if (ec || modules.size() >= 64) {
                break;
            }
            const std::string directoryName = entry.path().filename().string();
            if (directoryName.rfind("17-", 0) != 0) {
                continue;
            }

            const std::vector<unsigned char> raw = readBinaryFile(entry.path() / "raw");
            if (raw.size() < 0x1b || raw[0] != 17) {
                continue;
            }

            const std::size_t formattedLength = raw[1];
            Json::Value module(Json::objectValue);
            module["source"] = "smbios_type_17";
            module["entry"] = directoryName;
            const std::uint16_t sizeField = le16(raw, 0x0c);
            if (sizeField != 0 && sizeField != 0xffff) {
                Json::UInt64 sizeBytes = 0;
                if (sizeField == 0x7fff && raw.size() >= 0x20) {
                    sizeBytes = static_cast<Json::UInt64>(le32(raw, 0x1c)) * 1024ULL * 1024ULL;
                } else if ((sizeField & 0x8000U) != 0) {
                    sizeBytes = static_cast<Json::UInt64>(sizeField & 0x7fffU) * 1024ULL;
                } else {
                    sizeBytes = static_cast<Json::UInt64>(sizeField) * 1024ULL * 1024ULL;
                }
                if (sizeBytes > 0) {
                    module["size_bytes"] = sizeBytes;
                }
            }

            const int formFactor = raw.size() > 0x0e ? raw[0x0e] : 0;
            const std::string formFactorName = memoryFormFactorName(formFactor);
            if (!formFactorName.empty()) {
                module["form_factor"] = formFactorName;
            }

            if (raw.size() > 0x12) {
                const std::string typeName = memoryTypeName(raw[0x12]);
                if (!typeName.empty()) {
                    module["type"] = typeName;
                }
            }

            const std::uint16_t speed = le16(raw, 0x15);
            if (speed > 0 && speed != 0xffff) {
                module["speed_mhz"] = speed;
            }
            const std::uint16_t configuredSpeed = le16(raw, 0x20);
            if (configuredSpeed > 0 && configuredSpeed != 0xffff) {
                module["configured_speed_mhz"] = configuredSpeed;
            }

            const std::string locator = dmiStringAt(raw, formattedLength, raw.size() > 0x10 ? raw[0x10] : 0);
            const std::string bankLocator = dmiStringAt(raw, formattedLength, raw.size() > 0x11 ? raw[0x11] : 0);
            const std::string manufacturer = dmiStringAt(raw, formattedLength, raw.size() > 0x17 ? raw[0x17] : 0);
            const std::string partNumber = dmiStringAt(raw, formattedLength, raw.size() > 0x1a ? raw[0x1a] : 0);
            if (!locator.empty()) module["locator"] = locator;
            if (!bankLocator.empty()) module["bank_locator"] = bankLocator;
            if (!manufacturer.empty()) module["brand"] = manufacturer;
            if (!partNumber.empty()) module["part_number"] = partNumber;

            module["cas_latency"] = Json::Value();
            module["cas_latency_note"] = "Not exposed by SMBIOS type 17; requires readable SPD timing data on most systems.";
            modules.append(module);
        }
    }

    if (modules.empty() && fs::exists("/sys/devices/system/edac/mc", ec)) {
        for (const auto& controller : fs::directory_iterator("/sys/devices/system/edac/mc", fs::directory_options::skip_permission_denied, ec)) {
            if (ec || modules.size() >= 64 || controller.path().filename().string().rfind("mc", 0) != 0) {
                continue;
            }
            for (const auto& dimm : fs::directory_iterator(controller.path(), fs::directory_options::skip_permission_denied, ec)) {
                if (ec || modules.size() >= 64 || dimm.path().filename().string().rfind("dimm", 0) != 0) {
                    continue;
                }
                Json::Value module(Json::objectValue);
                module["source"] = "edac_sysfs";
                module["controller"] = controller.path().filename().string();
                module["entry"] = dimm.path().filename().string();
                const std::string label = readFirstLine(dimm.path() / "dimm_label");
                const std::string location = readFirstLine(dimm.path() / "dimm_location");
                const std::string sizeMb = readFirstLine(dimm.path() / "size_mb");
                const std::string type = readFirstLine(dimm.path() / "dimm_mem_type");
                if (!label.empty()) module["label"] = label;
                if (!location.empty()) module["location"] = location;
                if (!type.empty()) module["type"] = type;
                if (!sizeMb.empty()) {
                    try {
                        module["size_bytes"] = static_cast<Json::UInt64>(std::stoull(sizeMb) * 1024ULL * 1024ULL);
                    } catch (...) {
                    }
                }
                module["cas_latency"] = Json::Value();
                module["cas_latency_note"] = "Not exposed by EDAC sysfs on this system.";
                modules.append(module);
            }
        }
    }

    memory["modules"] = modules;
    memory["module_detail_note"] = modules.empty()
        ? "RAM brand, configuration, frequency, and CAS latency were not exposed through readable SMBIOS or EDAC sysfs data."
        : "RAM module details are best-effort from readable SMBIOS or EDAC sysfs data; CAS latency usually requires SPD access.";
#endif
    return memory;
}

Json::Value collectGpu() {
    Json::Value gpus(Json::arrayValue);
#ifndef _WIN32
    std::error_code ec;
    if (!fs::exists("/sys/class/drm", ec)) {
        return gpus;
    }

    for (const auto& entry : fs::directory_iterator("/sys/class/drm", fs::directory_options::skip_permission_denied, ec)) {
        if (ec || gpus.size() >= 16) {
            break;
        }
        const std::string cardName = entry.path().filename().string();
        if (cardName.rfind("card", 0) != 0 || cardName.find('-') != std::string::npos) {
            continue;
        }

        const fs::path devicePath = entry.path() / "device";
        if (!fs::exists(devicePath, ec)) {
            continue;
        }

        Json::Value gpu(Json::objectValue);
        gpu["drm_card"] = cardName;
        gpu["source"] = "drm_sysfs";
        const std::string vendor = readFirstLine(devicePath / "vendor");
        const std::string device = readFirstLine(devicePath / "device");
        const std::string subsystemVendor = readFirstLine(devicePath / "subsystem_vendor");
        const std::string subsystemDevice = readFirstLine(devicePath / "subsystem_device");
        const std::string pciClass = readFirstLine(devicePath / "class");
        const PciNameLookup pciName = lookupPciName(vendor, device, subsystemVendor, subsystemDevice);
        if (!vendor.empty()) {
            gpu["vendor_id"] = vendor;
            const std::string fallbackBrand = pciVendorName(vendor);
            if (!pciName.vendorName.empty()) {
                gpu["vendor_name"] = pciName.vendorName;
                gpu["brand"] = pciName.vendorName;
            } else if (!fallbackBrand.empty()) {
                gpu["brand"] = fallbackBrand;
            }
        }
        if (!device.empty()) gpu["device_id"] = device;
        if (!subsystemVendor.empty()) gpu["subsystem_vendor_id"] = subsystemVendor;
        if (!subsystemDevice.empty()) gpu["subsystem_device_id"] = subsystemDevice;
        if (!pciClass.empty()) gpu["pci_class"] = pciClass;
        if (!pciName.deviceName.empty()) {
            gpu["device_name"] = pciName.deviceName;
        }
        if (!pciName.subsystemName.empty()) {
            gpu["subsystem_name"] = pciName.subsystemName;
        }
        if (!pciName.sourcePath.empty()) {
            gpu["name_source"] = pciName.sourcePath;
        }
        if (!pciName.deviceName.empty() && !pciName.vendorName.empty()) {
            gpu["name"] = pciName.vendorName + " " + pciName.deviceName;
        } else if (!pciName.deviceName.empty()) {
            gpu["name"] = pciName.deviceName;
        } else if (!pciName.vendorName.empty()) {
            gpu["name"] = pciName.vendorName + " device " + normalizePciId(device);
        } else {
            gpu["name"] = cardName;
        }

        const fs::path driverPath = devicePath / "driver";
        if (fs::exists(driverPath, ec)) {
            const fs::path target = fs::read_symlink(driverPath, ec);
            if (!ec && !target.empty()) {
                gpu["driver"] = target.filename().string();
            }
        }

        const fs::path hwmonPath = devicePath / "hwmon";
        Json::Value telemetry(Json::objectValue);
        if (fs::exists(hwmonPath, ec)) {
            for (const auto& hwmon : fs::directory_iterator(hwmonPath, fs::directory_options::skip_permission_denied, ec)) {
                if (ec) {
                    break;
                }
                const std::string temp = readFirstLine(hwmon.path() / "temp1_input");
                const std::string fan = readFirstLine(hwmon.path() / "fan1_input");
                const std::string power = readFirstLine(hwmon.path() / "power1_average");
                if (!temp.empty()) telemetry["temperature_millicelsius"] = temp;
                if (!fan.empty()) telemetry["fan_rpm"] = fan;
                if (!power.empty()) telemetry["power_microwatts"] = power;
                break;
            }
        }
        if (!telemetry.empty()) {
            gpu["telemetry"] = telemetry;
        }

        gpus.append(gpu);
    }
#endif
    return gpus;
}

Json::Value collectStorage() {
    Json::Value storage(Json::objectValue);
#ifndef _WIN32
    struct statvfs stats {};
    if (statvfs("/", &stats) == 0) {
        storage["root_total_bytes"] = static_cast<Json::UInt64>(stats.f_blocks) * stats.f_frsize;
        storage["root_free_bytes"] = static_cast<Json::UInt64>(stats.f_bfree) * stats.f_frsize;
        storage["root_available_bytes"] = static_cast<Json::UInt64>(stats.f_bavail) * stats.f_frsize;
    }

    Json::Value blockDevices(Json::arrayValue);
    std::error_code ec;
    if (fs::exists("/sys/block", ec)) {
        for (const auto& entry : fs::directory_iterator("/sys/block", fs::directory_options::skip_permission_denied, ec)) {
            if (ec || blockDevices.size() >= 24) {
                break;
            }
            const std::string name = entry.path().filename().string();
            if (name.rfind("loop", 0) == 0 || name.rfind("ram", 0) == 0) {
                continue;
            }
            Json::Value device(Json::objectValue);
            device["name"] = name;
            const std::string sizeSectors = readFirstLine(entry.path() / "size");
            if (!sizeSectors.empty()) {
                try {
                    const auto sizeBytes = static_cast<Json::UInt64>(std::stoull(sizeSectors) * 512ULL);
                    device["size_bytes"] = sizeBytes;
                } catch (...) {
                }
            }
            device["rotational"] = readFirstLine(entry.path() / "queue" / "rotational");
            blockDevices.append(device);
        }
    }
    storage["block_devices"] = blockDevices;
#endif
    return storage;
}

Json::Value collectHardware() {
    Json::Value hardware(Json::objectValue);
    hardware["cpu"] = collectCpu();
    hardware["gpu"] = collectGpu();
    hardware["memory"] = collectMemory();
    hardware["storage"] = collectStorage();
#ifndef _WIN32
    const std::string productName = readFirstLine("/sys/class/dmi/id/product_name");
    const std::string productVersion = readFirstLine("/sys/class/dmi/id/product_version");
    const std::string boardVendor = readFirstLine("/sys/class/dmi/id/board_vendor");
    if (!productName.empty()) {
        hardware["system"]["product_name"] = productName;
    }
    if (!productVersion.empty()) {
        hardware["system"]["product_version"] = productVersion;
    }
    if (!boardVendor.empty()) {
        hardware["system"]["board_vendor"] = boardVendor;
    }
#endif
    return hardware;
}

Json::Value collectSoftware() {
    Json::Value software(Json::objectValue);
    software["package_managers"] = presentExecutables({
        "apt", "dnf", "yum", "pacman", "zypper", "apk", "brew", "flatpak", "snap"
    });
    software["runtimes"] = presentExecutables({
        "python3", "python", "node", "npm", "deno", "bun", "go", "rustc", "cargo", "java", "dotnet"
    });
    software["build_tools"] = presentExecutables({
        "cc", "gcc", "g++", "clang", "clang++", "cmake", "make", "ninja", "pkg-config", "git"
    });
    software["container_tools"] = presentExecutables({
        "docker", "podman", "kubectl", "nerdctl", "lxc"
    });

    const char* shell = std::getenv("SHELL");
    if (shell) {
        software["shell"] = shell;
    }
    const char* desktop = std::getenv("XDG_CURRENT_DESKTOP");
    if (desktop) {
        software["desktop"] = desktop;
    }
    const char* session = std::getenv("XDG_SESSION_TYPE");
    if (session) {
        software["session_type"] = session;
    }
    return software;
}

Json::Value collectOther() {
    Json::Value other(Json::objectValue);
#ifndef _WIN32
    struct sysinfo info {};
    if (sysinfo(&info) == 0) {
        other["uptime_seconds"] = static_cast<Json::Int64>(info.uptime);
        other["load_average_1m"] = static_cast<double>(info.loads[0]) / 65536.0;
        other["load_average_5m"] = static_cast<double>(info.loads[1]) / 65536.0;
        other["load_average_15m"] = static_cast<double>(info.loads[2]) / 65536.0;
    }
    other["virtualization_hint"] = readFirstLine("/sys/class/dmi/id/product_name");
    other["container_hints"] = makeArray({
        fs::exists("/.dockerenv") ? "/.dockerenv" : "",
        fs::exists("/run/.containerenv") ? "/run/.containerenv" : ""
    });
#endif
    return other;
}

} // namespace

Json::Value local_ecosystem_tool::inspect(const Json::Value&) {
    Json::Value result(Json::objectValue);
    result["os"] = collectOs();
    result["os_age"] = collectAge();
    result["hardware"] = collectHardware();
    result["kernel_version"] = result["os"]["kernel"].get("release", "");
    result["software"] = collectSoftware();
    result["other"] = collectOther();
    return result;
}
