"""Local media library and quiet, looping Qt background music."""
import hashlib
import json
import os
import shutil
import copy
import uuid
import time
import re
from contextlib import contextmanager
from pathlib import Path
from PySide6.QtCore import QObject, QUrl
from PySide6.QtGui import QImageReader
from PySide6.QtMultimedia import QAudioOutput, QMediaPlayer


def model_label(name):
    label = re.sub(r'\s*(?:[·—-]\s*)?(?:瞳孔跟随\s*)?(?:[（(]\s*验收版\s*[）)]|验收版)\s*$', '', name)
    label = re.sub(r'\s*(?:[·—-]\s*)?瞳孔跟随\s*$', '', label)
    return label.strip(' ·—-') or '角色'


class MediaLibrary:
    model_label = staticmethod(model_label)

    def __init__(self, root=None):
        explicit = root is not None or bool(os.environ.get('AMADEUS_MEDIA_DIR') or os.environ.get('AMADEUS_DATA_DIR'))
        self.root = Path(root or os.environ.get('AMADEUS_MEDIA_DIR') or
                         (Path(os.environ['AMADEUS_DATA_DIR']) / 'media' if os.environ.get('AMADEUS_DATA_DIR')
                          else Path.home() / '.amadeus' / 'media'))
        self.root.mkdir(parents=True, exist_ok=True)
        self.file = self.root / 'library.json'
        self.load_error = ''
        self.bundle_error = ''
        self.recovered = False
        try:
            self.state = json.loads(self.file.read_text(encoding='utf-8'))
            if not isinstance(self.state, dict):
                raise ValueError('invalid media library')
        except FileNotFoundError:
            self.state = {}
        except (OSError, ValueError):
            self.load_error = '素材库读取失败，已保留原文件'
            self.state = {}
            try:
                backup = json.loads(self.file.with_name('library.previous.json').read_text(encoding='utf-8'))
                if isinstance(backup, dict):
                    self.state, self.recovered = backup, True
            except (OSError, ValueError):
                pass
        for key, default in {'music': [], 'backgrounds': [], 'models': [],
                             'track': '', 'background': '', 'enabled': True, 'volume': 12,
                             'selected_model': '', 'framing': 'normal', 'ringtone': ''}.items():
            self.state.setdefault(key, default)
        for key in ('music', 'backgrounds', 'models'):
            self.state[key] = [row for row in self.state[key] if isinstance(row, dict)
                               and isinstance(row.get('name'), str) and isinstance(row.get('file'), str)] if isinstance(self.state[key], list) else []
        try:
            self.state['volume'] = max(0, min(30, int(self.state['volume'])))
        except (TypeError, ValueError):
            self.state['volume'] = 12
        self._saved = copy.deepcopy(self.state)
        if not explicit:
            self._migrate_appdata()
        if root is None:
            try:
                self.install_bundle(Path(__file__).resolve().parents[1] / 'assets' / 'media')
            except (OSError, ValueError, TypeError) as error:
                self.bundle_error = str(error)

    def install_bundle(self, folder):
        """Import the published, hash-checked media without replacing user data."""
        folder = Path(folder)
        catalog_file = folder / 'catalog.json'
        if not catalog_file.is_file():
            return False
        if self.load_error and not self.recovered:
            raise OSError(self.load_error)
        raw = catalog_file.read_bytes()
        bundle = json.loads(raw)
        if not isinstance(bundle, dict) or bundle.get('id') != 'amadeus-default-media':
            raise ValueError('素材包目录格式错误')
        version = bundle.get('version', '')
        if not isinstance(version, str) or not re.fullmatch(r'\d+\.\d+\.\d+', version):
            raise ValueError('素材包版本格式错误')
        entries = bundle.get('files')
        if not isinstance(entries, list) or not entries or len(entries) > 2000:
            raise ValueError('素材包文件清单无效')

        def digest(path):
            with path.open('rb') as handle:
                return hashlib.file_digest(handle, 'sha256').hexdigest()

        def member(base, relative):
            if not isinstance(relative, str) or not relative or '\\' in relative or ':' in relative:
                raise ValueError('素材包路径无效')
            parts = relative.split('/')
            if any(part in ('', '.', '..') or part.endswith((' ', '.')) for part in parts):
                raise ValueError('素材包路径无效')
            path = base.joinpath(*parts)
            if not path.resolve().is_relative_to(base.resolve()):
                raise ValueError('素材包路径越过目录')
            if any(base.joinpath(*parts[:n]).is_symlink() for n in range(1, len(parts)+1)):
                raise ValueError('素材包不能包含文件链接')
            return path

        files = {}
        for entry in entries:
            if not isinstance(entry, dict):
                raise ValueError('素材包文件清单无效')
            relative, expected = entry.get('path'), entry.get('sha256')
            source = member(folder, relative)
            category = relative.split('/')[0]
            allowed = {'music': {'.ogg', '.mp3', '.wav', '.flac', '.m4a'},
                       'backgrounds': {'.png', '.jpg', '.jpeg', '.webp', '.bmp'},
                       'models': {'.json', '.moc3', '.png', '.jpg', '.jpeg'},
                       'ringtones': {'.ogg', '.mp3', '.wav'}}
            if source.suffix.lower() not in allowed.get(category, set()) or source.name in ('config.json', 'secrets.json'):
                raise ValueError('素材包包含未允许的文件')
            if relative in files or not isinstance(expected, str) or not re.fullmatch('[a-f0-9]{64}', expected):
                raise ValueError('素材包文件校验信息无效')
            if not source.is_file() or source.stat().st_size != entry.get('size') or digest(source) != expected:
                raise ValueError('素材包校验失败，请重新解压安装包')
            files[relative] = (source, expected)
        rows = {}
        for kind in ('music', 'backgrounds', 'models'):
            supplied = bundle.get(kind)
            if not isinstance(supplied, list):
                raise ValueError('素材包分类目录无效')
            rows[kind] = []
            for row in supplied:
                if not isinstance(row, dict) or not isinstance(row.get('name'), str) or row.get('file') not in files or not row['file'].startswith(kind+'/'):
                    raise ValueError('素材包条目缺少文件')
                clean = {'name': model_label(row['name']) if kind == 'models' else row['name'], 'file': row['file']}
                if kind == 'models' and row.get('tracking') == 'eyes':
                    clean['tracking'] = 'eyes'
                rows[kind].append(clean)
        defaults = bundle.get('defaults', {})
        if not isinstance(defaults, dict):
            raise ValueError('素材包默认值无效')
        for key, kind in (('track', 'music'), ('background', 'backgrounds'), ('selected_model', 'models')):
            if defaults.get(key) and defaults[key] not in {row['file'] for row in rows[kind]}:
                raise ValueError('素材包默认条目缺少文件')
        if defaults.get('ringtone') and defaults['ringtone'] not in files:
            raise ValueError('素材包缺少来电音乐')

        marker = self.root / '.bundle-installed.json'
        with self._catalog_lock():
            previous = {}
            try:
                previous = json.loads(marker.read_text(encoding='utf-8'))
                if not isinstance(previous, dict):
                    previous = {}
            except (OSError, ValueError):
                pass
            prior_version = previous.get('version', '')
            if isinstance(prior_version, str) and re.fullmatch(r'\d+\.\d+\.\d+', prior_version):
                if tuple(map(int, prior_version.split('.'))) > tuple(map(int, version.split('.'))):
                    return False
            managed = previous.get('files', {})
            if not isinstance(managed, dict):
                managed = {}
            targets, current = {}, {}
            for relative in files:
                target = member(self.root, relative)
                targets[relative] = target
                current[relative] = digest(target) if target.is_file() else None
            # A hand-edited model is kept as a whole; do not mix its files with
            # a newer distributed texture or geometry from another revision.
            protected = set()
            for row in rows['models']:
                group = Path(row['file']).parent.as_posix()+'/'
                if any(current[rel] is not None and current[rel] not in (expected, managed.get(rel))
                       for rel, (_, expected) in files.items() if rel.startswith(group)):
                    protected.add(group)
            installed = {}
            copied = False
            for relative, (source, expected) in files.items():
                if any(relative.startswith(group) for group in protected):
                    if relative in managed:
                        installed[relative] = managed[relative]
                    continue
                target, existing = targets[relative], current[relative]
                if existing is not None and existing not in (expected, managed.get(relative)):
                    continue
                if existing != expected:
                    target.parent.mkdir(parents=True, exist_ok=True)
                    if existing:
                        backup = member(self.root, '.bundle-backups/'+existing+'/'+relative)
                        backup.parent.mkdir(parents=True, exist_ok=True)
                        if not backup.exists():
                            shutil.copy2(target, backup)
                    temporary = target.with_name('.bundle-'+uuid.uuid4().hex+'.tmp')
                    try:
                        shutil.copy2(source, temporary)
                        if digest(temporary) != expected:
                            raise OSError('素材复制校验失败')
                        os.replace(temporary, target)
                    finally:
                        if temporary.exists():
                            temporary.unlink()
                    copied = True
                installed[relative] = expected
            fresh = not self.file.exists() and not any(self.state[kind] for kind in rows)
            changed = False
            for kind, supplied in rows.items():
                known = {row['file'] for row in self.state[kind]}
                for row in supplied:
                    if row['file'] not in known and self.path(row['file']):
                        self.state[kind].append(row)
                        known.add(row['file'])
                        changed = True
            if fresh:
                for key in ('track', 'background', 'selected_model', 'framing', 'enabled', 'volume', 'ringtone'):
                    if key in defaults:
                        self.state[key] = defaults[key]
                changed = True
            if changed:
                self._save_locked()
            record = {'id': bundle['id'], 'version': version,
                      'catalog_sha256': hashlib.sha256(raw).hexdigest(), 'files': installed}
            if record != previous:
                temporary = marker.with_name('.bundle-marker-'+uuid.uuid4().hex+'.tmp')
                temporary.write_text(json.dumps(record, indent=2), encoding='utf-8')
                os.replace(temporary, marker)
            return copied or changed

    def _migrate_appdata(self):
        marker = self.root / 'migrated-from-appdata.json'
        if marker.exists() or self.load_error:
            return
        legacy_root = Path(os.environ.get('LOCALAPPDATA', '.')) / 'Amadeus' / 'media'
        if not (legacy_root / 'library.json').is_file() or legacy_root.resolve() == self.root.resolve():
            return
        legacy = MediaLibrary(legacy_root)
        if legacy.load_error and not legacy.recovered:
            return
        fresh = not self.file.exists()
        for kind in ('music', 'backgrounds', 'models'):
            known = {row['file'] for row in self.state[kind]}
            for row in legacy.state[kind]:
                member = Path(row['file'])
                if member.is_absolute() or member.drive or '..' in member.parts or not member.parts or member.parts[0] != kind:
                    continue
                source = legacy.path(row['file'])
                if source:
                    candidates = source.parent.rglob('*') if kind == 'models' else [source]
                    for candidate in candidates:
                        resolved = candidate.resolve()
                        if not candidate.is_file() or not any(resolved.is_relative_to(anchor) for anchor in legacy._storage_roots()):
                            continue
                        relative = member.parent / candidate.relative_to(source.parent) if kind == 'models' else member
                        destination = self.root / relative
                        destination.parent.mkdir(parents=True, exist_ok=True)
                        if not destination.exists():
                            shutil.copy2(candidate, destination)
                if row['file'] not in known:
                    self.state[kind].append(copy.deepcopy(row))
                    known.add(row['file'])
        if fresh:
            for key, value in legacy.state.items():
                if key not in ('music', 'backgrounds', 'models'):
                    self.state[key] = copy.deepcopy(value)
        self.save()
        marker.write_text(json.dumps({'source': 'appdata-media', 'version': 1}), encoding='utf-8')

    def save(self):
        with self._catalog_lock():
            self._save_locked()

    @contextmanager
    def _catalog_lock(self):
        # Coordinate real windows and the installer, including simultaneous
        # writes. Atomic rename alone protects JSON but can still lose rows.
        with (self.root / '.library.lock').open('a+b') as handle:
            acquired = False
            deadline = time.monotonic() + 1.0
            try:
                while not acquired:
                    try:
                        handle.seek(0)
                        if os.name == 'nt':
                            import msvcrt
                            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
                        else:
                            import fcntl
                            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                        acquired = True
                    except OSError:
                        if time.monotonic() >= deadline:
                            raise OSError('素材库正被其他窗口写入，请重试')
                        time.sleep(.01)
                yield
            finally:
                if acquired:
                    handle.seek(0)
                    if os.name == 'nt':
                        import msvcrt
                        msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
                    else:
                        import fcntl
                        fcntl.flock(handle.fileno(), fcntl.LOCK_UN)

    def _save_locked(self):
        if self.load_error and not self.recovered:
            raise OSError(self.load_error)
        disk = {}
        try:
            disk = json.loads(self.file.read_text(encoding='utf-8'))
            if not isinstance(disk, dict):
                raise ValueError('invalid media library')
        except FileNotFoundError:
            pass
        except (OSError, ValueError) as error:
            if not self.recovered:
                raise OSError('素材库发生变化且无法读取，未覆盖原文件') from error
            disk = {}
        merged = copy.deepcopy(disk)
        for key, value in self.state.items():
            previous = self._saved.get(key)
            if key in merged and value == previous:
                continue
            if key in ('music', 'backgrounds', 'models') and isinstance(merged.get(key), list):
                old = {row['file']: row for row in previous or []}
                current = {row['file']: row for row in value}
                removed = old.keys() - current.keys()
                changed = {name: row for name, row in current.items() if row != old.get(name)}
                rows = [changed.pop(row['file'], row) for row in merged[key]
                        if isinstance(row, dict) and isinstance(row.get('file'), str) and row['file'] not in removed]
                merged[key] = rows + list(changed.values())
            else:
                merged[key] = copy.deepcopy(value)
        temporary = self.root / ('.library-' + uuid.uuid4().hex + '.tmp')
        try:
            with temporary.open('w', encoding='utf-8') as output:
                json.dump(merged, output, ensure_ascii=False, indent=2)
                output.flush()
                os.fsync(output.fileno())
            physical = temporary.resolve()
            target = physical.parent / self.file.name
            if disk:
                backup = physical.parent / 'library.previous.json'
                backup_temporary = backup.with_name('.previous-' + uuid.uuid4().hex + '.tmp')
                backup_temporary.write_text(json.dumps(disk, ensure_ascii=False, indent=2), encoding='utf-8')
                os.replace(backup_temporary, backup)
            elif self.recovered and self.file.exists():
                shutil.copy2(self.file, physical.parent / ('library.corrupt-' + uuid.uuid4().hex + '.json'))
            os.replace(physical, target)
        finally:
            if temporary.exists():
                temporary.unlink()
        self.state = merged
        self._saved = copy.deepcopy(merged)
        self.load_error, self.recovered = '', False

    def import_file(self, source, kind):
        source = Path(source)
        allowed = {'music': ('.ogg', '.mp3', '.wav', '.flac', '.m4a'),
                   'backgrounds': ('.png', '.jpg', '.jpeg', '.webp', '.bmp')}
        if kind not in allowed or source.suffix.lower() not in allowed[kind]:
            raise ValueError('不支持的媒体格式')
        if kind == 'backgrounds' and not QImageReader(str(source)).canRead():
            raise ValueError('无法读取这张图片，请选择有效的 PNG、JPEG、WebP 或 BMP 文件')
        digest = hashlib.sha256(source.read_bytes()).hexdigest()[:20]
        target = self.root / kind / (digest + source.suffix.lower())
        target.parent.mkdir(parents=True, exist_ok=True)
        if not target.exists():
            shutil.copy2(source, target)
        relative = target.relative_to(self.root).as_posix()
        if not any(row['file'] == relative for row in self.state[kind]):
            self.state[kind].append({'name': source.stem, 'file': relative})
        self.save()
        return relative

    def _storage_roots(self):
        roots = [self.root.resolve()]
        # Packaged Windows processes can redirect child files into LocalCache
        # while resolve(media/) still names the logical AppData directory.
        # The actual library file provides the corresponding storage root.
        if os.name == 'nt' and self.file.is_file() and not self.file.is_symlink():
            roots.append(self.file.resolve().parent)
        return roots

    def path(self, relative):
        if not relative:
            return None
        try:
            member = Path(relative)
            if member.is_absolute() or member.drive or '..' in member.parts:
                return None
            target = (self.root / member).resolve()
            return target if target.is_file() and any(
                target.is_relative_to(root) for root in self._storage_roots()) else None
        except (TypeError, OSError, RuntimeError, ValueError):
            return None


class BackgroundMusic(QObject):
    def __init__(self, library, parent=None):
        super().__init__(parent)
        self.library = library
        self.output = QAudioOutput(self)
        self.player = QMediaPlayer(self)
        self.player.setAudioOutput(self.output)
        self.player.setLoops(QMediaPlayer.Loops.Infinite)
        self.speaking = self.calling = False

    def apply(self):
        state = self.library.state
        track = self.library.path(state['track'])
        if not state['enabled'] or not track:
            self.player.stop()
            return
        source = QUrl.fromLocalFile(str(track))
        if self.player.source() != source:
            self.player.setSource(source)
        self.update_volume()
        self.player.play()

    def update_volume(self):
        value = max(0, min(30, int(self.library.state['volume']))) / 100
        self.output.setVolume(0 if self.calling else value * (.25 if self.speaking else 1))

    def stop(self):
        self.player.stop()


if __name__ == '__main__':
    import sys
    if sys.argv[1:] != ['--install-bundle']:
        raise SystemExit('Usage: media.py --install-bundle')
    library = MediaLibrary()
    if library.bundle_error:
        print('Media bundle installation failed:', library.bundle_error)
        raise SystemExit(1)
    print('Media ready:', len(library.state['models']), 'models,', len(library.state['music']),
          'music tracks,', len(library.state['backgrounds']), 'backgrounds')
