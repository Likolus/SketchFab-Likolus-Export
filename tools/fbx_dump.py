#!/usr/bin/env python3
"""fbx_dump.py - minimal FBX binary parser that prints the node tree.

Usage: python3 fbx_dump.py <file.fbx> [max_depth]

Prints each node: name, property types+values (abbreviated), and children
indented. Helps spot structural issues (missing props, wrong subclass, etc.).
"""
import sys
import struct

def read_fbx(path):
    with open(path, 'rb') as f:
        data = f.read()
    # Header: 21 bytes magic + 2 bytes (0x00 0x1a) + 4 bytes version
    magic = data[:21]
    rest = data[21:]
    # rest[0:2] should be 0x00 0x1a
    version = struct.unpack('<I', rest[2:6])[0]
    print(f"Magic: {magic!r}")
    print(f"Version: {version}")
    print()
    pos = 27  # after header
    # Top-level: a sequence of nodes ending with a null record (13 zero bytes)
    nodes = []
    while pos < len(data):
        end_offset, num_props, prop_len, name_len = struct.unpack('<IIIB', data[pos:pos+13])
        if end_offset == 0 and num_props == 0 and prop_len == 0 and name_len == 0:
            # null record (end of children)
            break
        node, pos = read_node(data, pos)
        nodes.append(node)
    return nodes

def read_node(data, pos):
    end_offset, num_props, prop_len, name_len = struct.unpack('<IIIB', data[pos:pos+13])
    start = pos
    pos += 13
    name = data[pos:pos+name_len].decode('latin1')
    pos += name_len
    props = []
    for _ in range(num_props):
        p, pos = read_prop(data, pos)
        props.append(p)
    children = []
    if pos < end_offset:
        # has children
        while pos < end_offset - 13:
            child_end, _, _, child_name_len = struct.unpack('<IIIB', data[pos:pos+13])
            if child_end == 0 and child_name_len == 0:
                pos += 13
                break
            child, pos = read_node(data, pos)
            children.append(child)
        # skip null record
        if pos < end_offset:
            pos = end_offset
    return {'name': name, 'props': props, 'children': children}, pos

def read_prop(data, pos):
    t = chr(data[pos])
    pos += 1
    if t == 'S':
        ln = struct.unpack('<I', data[pos:pos+4])[0]
        pos += 4
        val = data[pos:pos+ln]
        pos += ln
        # try to show as string, with \x00\x01 shown explicitly
        try:
            s = val.decode('utf8')
        except:
            s = val.decode('latin1')
        return ('S', s, val), pos
    elif t == 'Y':
        v = struct.unpack('<h', data[pos:pos+2])[0]; pos += 2
        return ('Y', v), pos
    elif t == 'C':
        v = data[pos]; pos += 1
        return ('C', v), pos
    elif t == 'I':
        v = struct.unpack('<i', data[pos:pos+4])[0]; pos += 4
        return ('I', v), pos
    elif t == 'F':
        v = struct.unpack('<f', data[pos:pos+4])[0]; pos += 4
        return ('F', v), pos
    elif t == 'D':
        v = struct.unpack('<d', data[pos:pos+8])[0]; pos += 8
        return ('D', v), pos
    elif t == 'L':
        v = struct.unpack('<q', data[pos:pos+8])[0]; pos += 8
        return ('L', v), pos
    elif t == 'd':
        ln = struct.unpack('<I', data[pos:pos+4])[0]; pos += 4
        enc = struct.unpack('<I', data[pos:pos+4])[0]; pos += 4
        ln2 = struct.unpack('<I', data[pos:pos+4])[0]; pos += 4
        arr = struct.unpack('<%dd' % ln, data[pos:pos+ln*8]); pos += ln*8
        return ('d[]', list(arr)[:6] + (['...'] if ln > 6 else [])), pos
    elif t == 'i':
        ln = struct.unpack('<I', data[pos:pos+4])[0]; pos += 4
        enc = struct.unpack('<I', data[pos:pos+4])[0]; pos += 4
        ln2 = struct.unpack('<I', data[pos:pos+4])[0]; pos += 4
        arr = struct.unpack('<%di' % ln, data[pos:pos+ln*4]); pos += ln*4
        return ('i[]', list(arr)[:6] + (['...'] if ln > 6 else [])), pos
    else:
        return ('?'+t, None), pos

def fmt_prop(p):
    t = p[0]
    if t == 'S':
        s = p[1]
        raw = p[2]
        # show \x00\x01 explicitly
        disp = raw.decode('latin1').replace('\x00', '\\x00').replace('\x01', '\\x01')
        if len(disp) > 50:
            disp = disp[:50] + '...'
        return f'S("{disp}")'
    elif t in ('d[]', 'i[]'):
        return f'{t}{p[1]}'
    else:
        return f'{t}({p[1]!r})'

def print_node(node, depth=0, max_depth=10):
    if depth > max_depth:
        return
    indent = '  ' * depth
    props_str = ', '.join(fmt_prop(p) for p in node['props'])
    child_count = len(node['children'])
    print(f"{indent}{node['name']}({props_str}) [{child_count} children]")
    for c in node['children']:
        print_node(c, depth+1, max_depth)

if __name__ == '__main__':
    path = sys.argv[1]
    max_depth = int(sys.argv[2]) if len(sys.argv) > 2 else 10
    nodes = read_fbx(path)
    for n in nodes:
        print_node(n, 0, max_depth)
