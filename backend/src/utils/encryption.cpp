#include "utils/encryption.h"
#include <openssl/aes.h>
#include <openssl/rand.h>
#include <stdexcept>
#include <vector>
#include <string>

Encryption::Encryption(const std::string& encryptionKey) : key(encryptionKey) {
    if (key.empty()) {
        throw std::invalid_argument("Encryption key cannot be empty");
    }
}

std::string Encryption::encrypt(const std::string& data) const {
    std::vector<unsigned char> dataBytes(data.begin(), data.end());
    std::vector<unsigned char> encrypted = encryptBinary(dataBytes);
    return std::string(encrypted.begin(), encrypted.end());
}

std::string Encryption::decrypt(const std::string& encryptedData) const {
    std::vector<unsigned char> encryptedBytes(encryptedData.begin(), encryptedData.end());
    std::vector<unsigned char> decrypted = decryptBinary(encryptedBytes);
    return std::string(decrypted.begin(), decrypted.end());
}

std::vector<unsigned char> Encryption::encryptBinary(const std::vector<unsigned char>& data) const {
    if (data.empty()) {
        return {};
    }

    // Generate random IV
    unsigned char iv[AES_BLOCK_SIZE];
    if (RAND_bytes(iv, AES_BLOCK_SIZE) != 1) {
        throw std::runtime_error("Failed to generate random IV");
    }

    // Prepare output buffer (data + IV)
    std::vector<unsigned char> output(data.size() + AES_BLOCK_SIZE);
    std::copy(iv, iv + AES_BLOCK_SIZE, output.begin());

    // Encrypt data
    AES_KEY aesKey;
    if (AES_set_encrypt_key(reinterpret_cast<const unsigned char*>(key.c_str()), key.size() * 8, &aesKey) != 0) {
        throw std::runtime_error("Failed to set AES encryption key");
    }

    AES_cbc_encrypt(data.data(), output.data() + AES_BLOCK_SIZE, data.size(), &aesKey, iv, AES_ENCRYPT);

    return output;
}

std::vector<unsigned char> Encryption::decryptBinary(const std::vector<unsigned char>& encryptedData) const {
    if (encryptedData.size() < AES_BLOCK_SIZE) {
        throw std::invalid_argument("Encrypted data too small");
    }

    // Extract IV
    unsigned char iv[AES_BLOCK_SIZE];
    std::copy(encryptedData.begin(), encryptedData.begin() + AES_BLOCK_SIZE, iv);

    // Prepare output buffer
    std::vector<unsigned char> output(encryptedData.size() - AES_BLOCK_SIZE);

    // Decrypt data
    AES_KEY aesKey;
    if (AES_set_decrypt_key(reinterpret_cast<const unsigned char*>(key.c_str()), key.size() * 8, &aesKey) != 0) {
        throw std::runtime_error("Failed to set AES decryption key");
    }

    AES_cbc_encrypt(encryptedData.data() + AES_BLOCK_SIZE, output.data(), output.size(), &aesKey, iv, AES_DECRYPT);

    return output;
}
