#ifndef ENCRYPTION_H
#define ENCRYPTION_H

#include <string>
#include <vector>
#include <stdexcept>

class Encryption {
private:
    std::string key;

public:
    Encryption(const std::string& encryptionKey);
    
    std::string encrypt(const std::string& data) const;
    std::string decrypt(const std::string& encryptedData) const;
    std::vector<unsigned char> encryptBinary(const std::vector<unsigned char>& data) const;
    std::vector<unsigned char> decryptBinary(const std::vector<unsigned char>& encryptedData) const;
};

#endif // ENCRYPTION_H
