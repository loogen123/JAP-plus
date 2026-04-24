import os
import glob
import re

files_to_check = []
for root, dirs, files in os.walk('src'):
    for file in files:
        if file.endswith('.ts') or file.endswith('.tsx') or file.endswith('.js'):
            files_to_check.append(os.path.join(root, file))
for root, dirs, files in os.walk('public'):
    for file in files:
        if file.endswith('.js') or file.endswith('.html') or file.endswith('.css'):
            files_to_check.append(os.path.join(root, file))

def replacer(match):
    val = match.group(0)
    if val == '"08"': return '"07"'
    if val == '"07"': return '"06"'
    if val == '"06"': return '"05"'
    if val == '08_Actionable_Tasks': return '07_Actionable_Tasks'
    if val == 'sdd08': return 'sdd07'
    if val == 'mod07': return 'mod06'
    if val == 'mod06': return 'mod05'
    return val

for filepath in files_to_check:
    with open(filepath, 'r', encoding='utf-8') as f:
        content = f.read()
    
    new_content = re.sub(r'"08"|"07"|"06"|08_Actionable_Tasks|sdd08|mod07|mod06', replacer, content)
    
    if new_content != content:
        with open(filepath, 'w', encoding='utf-8') as f:
            f.write(new_content)
        print(f"Updated {filepath}")
