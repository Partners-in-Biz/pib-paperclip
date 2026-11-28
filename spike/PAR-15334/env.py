# Fixed minimal env: no run, agent or secret values.
import os
def fixed_env(home):
    return {"PATH":"/usr/local/bin:/usr/bin:/bin:/opt/node24/bin","HOME":os.path.expanduser("~"),"HERMES_HOME":home,"LANG":"C.UTF-8"}
