import os
import shutil
import hashlib
import struct

# 配置路径
SOURCE_DIR = r'e:\桌面\洛佬の美图\LTYpicture\temporary'
DEST_DIR = r'e:\桌面\洛佬の美图\LTYpicture\wallpapers&illustration'
HENG_DIR = os.path.join(DEST_DIR, 'heng')
SHU_DIR = os.path.join(DEST_DIR, 'shu')

# 创建目标文件夹（如果不存在）
os.makedirs(HENG_DIR, exist_ok=True)
os.makedirs(SHU_DIR, exist_ok=True)

# 获取文件哈希值，用于检测重复图片
def get_file_hash(file_path):
    hash_md5 = hashlib.md5()
    with open(file_path, 'rb') as f:
        for chunk in iter(lambda: f.read(4096), b''):
            hash_md5.update(chunk)
    return hash_md5.hexdigest()

# 获取目标文件夹中所有图片的哈希值，用于去重检测
def get_existing_hashes():
    hashes = set()
    for root, _, files in os.walk(DEST_DIR):
        for file in files:
            if file.lower().endswith(('.png', '.jpg', '.jpeg', '.gif', '.bmp')):
                file_path = os.path.join(root, file)
                hashes.add(get_file_hash(file_path))
    return hashes

# 获取目标文件夹中最大的编号，用于生成新文件名
def get_max_number(folder):
    max_num = 0
    for file in os.listdir(folder):
        if file.lower().endswith(('.png', '.jpg', '.jpeg', '.gif', '.bmp')):
            # 提取文件名中的数字部分
            name, _ = os.path.splitext(file)
            if name.isdigit():
                num = int(name)
                if num > max_num:
                    max_num = num
    return max_num

# 获取图片尺寸（支持JPG、PNG、GIF、BMP）
def get_image_size(file_path):
    with open(file_path, 'rb') as f:
        head = f.read(32)
        if len(head) < 32:
            return None
        
        # JPG
        if head.startswith(b'\xff\xd8'):
            try:
                f.seek(0)
                size = 2
                ftype = 0
                while not 0xc0 <= ftype <= 0xcf:
                    f.seek(size, 1)
                    byte = f.read(1)
                    while byte != b'\xff':
                        byte = f.read(1)
                    while byte == b'\xff':
                        byte = f.read(1)
                    ftype = ord(byte)
                    size = struct.unpack('>H', f.read(2))[0] - 2
                # 现在是SOFn块，包含高度和宽度
                f.seek(1, 1)
                height = struct.unpack('>H', f.read(2))[0]
                width = struct.unpack('>H', f.read(2))[0]
                return width, height
            except Exception:
                return None
        
        # PNG
        elif head.startswith(b'\x89PNG\r\n\x1a\n'):
            try:
                f.seek(16)
                width = struct.unpack('>I', f.read(4))[0]
                height = struct.unpack('>I', f.read(4))[0]
                return width, height
            except Exception:
                return None
        
        # GIF
        elif head.startswith(b'GIF8'):
            try:
                width = struct.unpack('<H', head[6:8])[0]
                height = struct.unpack('<H', head[8:10])[0]
                return width, height
            except Exception:
                return None
        
        # BMP
        elif head.startswith(b'BM'):
            try:
                width = struct.unpack('<I', head[18:22])[0]
                height = struct.unpack('<I', head[22:26])[0]
                return width, abs(height)
            except Exception:
                return None
        
        return None

# 主函数
def main():
    # 获取现有图片哈希值
    existing_hashes = get_existing_hashes()
    
    # 获取当前最大编号
    max_heng = get_max_number(HENG_DIR)
    max_shu = get_max_number(SHU_DIR)
    
    # 遍历临时文件夹中的所有图片
    for file in os.listdir(SOURCE_DIR):
        file_path = os.path.join(SOURCE_DIR, file)
        
        # 跳过非图片文件
        if not file.lower().endswith(('.png', '.jpg', '.jpeg', '.gif', '.bmp')):
            continue
        
        # 检查是否为重复图片
        file_hash = get_file_hash(file_path)
        if file_hash in existing_hashes:
            print(f"跳过重复图片: {file}")
            continue
        
        # 获取图片尺寸信息
        size = get_image_size(file_path)
        if size is None:
            print(f"无法获取图片尺寸: {file}")
            continue
        
        width, height = size
        
        # 判断横竖版
        if width > height:
            target_folder = HENG_DIR
            max_heng += 1
            new_num = max_heng
        else:
            target_folder = SHU_DIR
            max_shu += 1
            new_num = max_shu
        
        # 获取文件扩展名（小写）
        ext = os.path.splitext(file)[1].lower()
        
        # 生成新文件名（4位数编号）
        new_filename = f"{new_num:04d}{ext}"
        new_file_path = os.path.join(target_folder, new_filename)
        
        # 移动文件（使用shutil.move保留元数据）
        shutil.move(file_path, new_file_path)
        print(f"移动并重命名: {file} -> {new_file_path}")
    
    print("\n图片整理完成！")

if __name__ == "__main__":
    main()